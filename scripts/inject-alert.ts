import { TrueForge } from '@truefoundry/trueforge-sdk';
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TRUEFORGE_BASE_URL =
  process.env.TRUEFORGE_URL || process.env.TRUEFORGE_BASE_URL || 'http://localhost:8790';

export interface InjectedAlertResult {
  sessionId: string;
  turnId: string;
  alert: any;
  toolsCalled: string[];
  autoTriggeredEvaluation: boolean;
  agentResponse: string;
}

/**
 * Extracts inner tool name from a tool call item, supporting both snake_case
 * and camelCase fields, plus unwrapping generic call_tool wrappers (Fix for Qodo #1)
 */
function extractToolName(call: any): string | null {
  if (!call) return null;

  // 1. Direct tool metadata from TrueForge turn event schema
  let name =
    call.tool_info?.name ||
    call.toolInfo?.name ||
    call.function?.name ||
    call.name ||
    call.tool;

  // 2. Unwrap generic call_tool wrappers if present
  if (name === 'call_tool' || !name) {
    try {
      const rawArgs = call.function?.arguments || call.arguments;
      const parsedArgs = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs || {};
      name = parsedArgs.tool_name || parsedArgs.name || name;
    } catch {}
  }

  return typeof name === 'string' ? name.trim() : null;
}

export async function injectDisruptionAlert(
  fixturePath = path.resolve(__dirname, '../fixtures/disruption-alert.json'),
  targetSessionId?: string
): Promise<InjectedAlertResult> {
  console.log('🚨 Starting Disruption Alert Ingestion Workflow (Ticket #06)...');

  // 1. Load and validate fixture
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Alert fixture not found at ${fixturePath}`);
  }

  const alertRaw = fs.readFileSync(fixturePath, 'utf8');
  const alert = JSON.parse(alertRaw);

  console.log(`📄 Ingested Alert: [${alert.event_id}] - ${alert.title}`);
  console.log(`   - Severity: ${alert.severity.toUpperCase()}`);
  console.log(`   - Region: ${alert.region}`);
  console.log(`   - Source: ${alert.source}`);

  if (alert.severity !== 'high' || alert.region !== 'East China Sea') {
    throw new Error(
      `❌ Ingestion validation failed: Alert must have severity="high" and region="East China Sea".`
    );
  }

  // 2. Connect to TrueForge
  console.log(`\n🔌 Connecting to TrueForge harness at: ${TRUEFORGE_BASE_URL}`);
  const client = new TrueForge({ baseUrl: TRUEFORGE_BASE_URL });

  // 3. Find or create session for disruption-triage-agent
  let sessionId = targetSessionId;
  if (!sessionId) {
    console.log(`✨ Creating dedicated disruption triage session for agent 'disruption-triage-agent'...`);
    const session = await client.sessions.create({
      agent: { name: 'disruption-triage-agent' },
    });
    sessionId = session.data.id;
    console.log(`   - Active Session ID: ${sessionId}`);
  } else {
    console.log(`🔄 Attaching to existing session: ${sessionId}`);
  }

  // 4. Construct webhook alert message with explicit triage instructions
  const alertPrompt = `[INCOMING AUTOMATED WEBHOOK ALERT - ${alert.event_id}]
A HIGH-SEVERITY disruption alert has just been received for your monitored corridor:

${JSON.stringify(alert, null, 2)}

INSTRUCTIONS:
Execute your standard disruption triage protocol immediately:
1. Inspect inventory buffer vulnerability for parts sourced from "${alert.region}" using read_inventory.
2. Identify the primary supplier and discover qualified alternate suppliers using read_suppliers.
3. Provide a clear written evaluation in your response summarizing affected stock, burn rate, and viable alternate suppliers.`;

  // 5. Post alert turn
  console.log(`\n📨 Injecting alert payload as turn to agent...`);
  const turn = await client.sessions.createTurn(sessionId, {
    input: [
      {
        type: 'user.message',
        content: alertPrompt,
      },
    ],
  });

  const turnId = turn.data.id;
  console.log(`   - Turn dispatched (${turnId}). Monitoring autonomous agent execution...`);

  // 6. Poll until turn finishes (allows sufficient time for multi-step agent reasoning & tool execution)
  let turnStatus = 'running';
  let completedTurn;
  const maxPollAttempts = 60;

  for (let i = 0; i < maxPollAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    completedTurn = await client.sessions.getTurn(sessionId, turnId);
    turnStatus = completedTurn.data.state.status;

    if (turnStatus !== 'running') {
      console.log(`\n🏁 Turn status finalized: ${turnStatus}`);
      break;
    }
    process.stdout.write('.');
  }

  // Fix for Qodo #3: Strictly reject any non-done terminal state (e.g. cancelled, error)
  if (turnStatus !== 'done') {
    throw new Error(
      `❌ Turn failed with non-successful status '${turnStatus}': ${JSON.stringify(completedTurn?.data.state)}`
    );
  }

  // 7. Extract events and evaluate autonomous tool execution
  const events = await client.sessions.listTurnEvents(sessionId, turnId);
  const toolsCalled: string[] = [];
  const responseParts: string[] = [];

  for (const ev of events.data || []) {
    const anyEv = ev as any;

    // Fix for Qodo #1: Check both tool_calls (snake_case) and toolCalls (camelCase)
    const calls = anyEv.tool_calls || anyEv.toolCalls;
    if (anyEv.type === 'model.message' && Array.isArray(calls)) {
      for (const call of calls) {
        const toolName = extractToolName(call);
        if (toolName) {
          toolsCalled.push(toolName);
          const args = call.function?.arguments || call.arguments || {};
          console.log(`🛠️ Autonomous Tool Call: ${toolName}(${typeof args === 'string' ? args : JSON.stringify(args)})`);
        }
      }
    }

    // Fix for Qodo #4: Collect response text independently of tool calls (not in an else-if)
    if (anyEv.type === 'model.message' && typeof anyEv.content === 'string' && anyEv.content.trim()) {
      responseParts.push(anyEv.content.trim());
    }

    // If an interactive question was asked, include it in response text
    if (anyEv.type === 'model.message' && Array.isArray(calls)) {
      for (const call of calls) {
        if (extractToolName(call) === 'ask_user_question') {
          try {
            const rawArgs = call.function?.arguments || call.arguments;
            const parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
            if (parsed.question) {
              responseParts.push(`[QUESTION TO OPERATOR]: ${parsed.question}`);
            }
          } catch {}
        }
      }
    }
  }

  const agentResponse = responseParts.join('\n\n');

  console.log(`\n📊 Summary of Autonomous Actions:`);
  console.log(`   - Total tools executed: ${toolsCalled.length}`);
  console.log(`   - Tool list: ${toolsCalled.join(', ') || 'None'}`);

  // Fix for Qodo #2: Require BOTH read_inventory AND read_suppliers
  const hasInventoryCheck = toolsCalled.includes('read_inventory');
  const hasSupplierCheck = toolsCalled.includes('read_suppliers');
  const autoTriggeredEvaluation = hasInventoryCheck && hasSupplierCheck;

  if (agentResponse) {
    console.log(`\n💬 Agent Triage Response:`);
    console.log(`--------------------------------------------------------------------------------`);
    console.log(agentResponse);
    console.log(`--------------------------------------------------------------------------------`);
  }

  return {
    sessionId,
    turnId,
    alert,
    toolsCalled,
    autoTriggeredEvaluation,
    agentResponse,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  injectDisruptionAlert()
    .then((res) => {
      console.log('\n✅ Disruption alert injection completed successfully.');
      if (res.autoTriggeredEvaluation) {
        console.log('🎯 Acceptance criteria verified: Agent auto-triggered both inventory and supplier evaluation.');
      }
    })
    .catch((err) => {
      console.error('\n❌ Disruption alert injection failed:', err);
      process.exit(1);
    });
}
