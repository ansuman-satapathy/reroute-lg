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
export function extractToolName(call: any): string | null {
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

  if (path.basename(fixturePath) === 'disruption-alert.json') {
    if (alert.severity !== 'high' || alert.region !== 'East China Sea') {
      throw new Error(
        `❌ Ingestion validation failed: Alert must have severity="high" and region="East China Sea".`
      );
    }
  } else {
    if (!alert.severity || !alert.region || !alert.event_id) {
      throw new Error(`❌ Ingestion validation failed: Custom alert must have event_id, severity, and region.`);
    }
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

  // 4. Construct webhook alert message with dynamic severity-specific instructions (Fix for Qodo #1)
  const isHighSeverity = String(alert.severity || '').toLowerCase() === 'high';
  const severityUpper = String(alert.severity || 'UNKNOWN').toUpperCase();

  let alertPrompt: string;
  if (isHighSeverity) {
    if (alert.type === 'labor_dispute' || alert.event_id?.includes('LABOR')) {
      alertPrompt = `[INCOMING AUTOMATED WEBHOOK ALERT - ${alert.event_id}]
A ${severityUpper}-SEVERITY port labor dispute alert has just been received for region "${alert.region}":

${JSON.stringify(alert, null, 2)}

INSTRUCTIONS:
Execute your standard disruption triage protocol immediately per your SOP:
1. Corroborate alert signals with live telemetry tools (Step 0) using get_news_disruptions.
2. Inspect inventory buffer vulnerability for parts sourced from "${alert.region}" using read_inventory.
3. Identify qualified alternate suppliers using read_suppliers. Because container terminals and port gates are halted by the dockworkers strike, evaluate candidate ocean carriers by delegating capacity, rate, and transit checks to parallel subagents using TrueForge's native create_sub_agent tool:
   - **MANDATORY CONCURRENCY**: You MUST emit all three create_sub_agent tool calls simultaneously in a single turn as a concurrent batch ("maersk-pacific", "evergreen-express", and "cma-cgm-asia" together). Do NOT invoke them sequentially one by one.
   - Each subagent must call query_carrier_capacity for its assigned carrier identifier (e.g. carrier: "maersk-pacific") and return transit days, TEU rates, and available space.
   - Synthesize the carrier findings in your response.
4. Run multi-criteria cost optimization in TrueForge's sandbox via exec across qualified candidates, formulate re-routing recommendations, output the complete 4-column Generative UI PO Diff Markdown table (| Metric | Baseline | Proposed Alternate | Variance / Delta |) directly in your chat response, and invoke propose_po_amendment to pause at the operator approval gate.`;
    } else {
      alertPrompt = `[INCOMING AUTOMATED WEBHOOK ALERT - ${alert.event_id}]
A ${severityUpper}-SEVERITY disruption alert has just been received for region "${alert.region}":

${JSON.stringify(alert, null, 2)}

INSTRUCTIONS:
Execute your standard disruption triage protocol immediately per your SOP:
1. Corroborate alert signals with live telemetry tools (Step 0).
2. Inspect inventory buffer vulnerability for parts sourced from "${alert.region}" using read_inventory.
3. Identify the primary supplier and discover qualified alternate suppliers using read_suppliers.
4. Run multi-criteria cost optimization in TrueForge's sandbox via exec, formulate re-routing recommendations, output the complete 4-column Generative UI PO Diff Markdown table (| Metric | Baseline | Proposed Alternate | Variance / Delta |) directly in your chat response, and invoke propose_po_amendment to pause at the operator approval gate.`;
    }
  } else {
    alertPrompt = `[INCOMING AUTOMATED WEBHOOK ALERT - ${alert.event_id}]
A ${severityUpper}-SEVERITY advisory has just been received for region "${alert.region}":

${JSON.stringify(alert, null, 2)}

INSTRUCTIONS:
Evaluate this incoming advisory per your disruption-triage SOP trigger rules. Note whether this advisory meets the severity threshold (HIGH only) and corridor exposure rules for active triage. If it is low-severity, routine maintenance, or outside monitored supplier regions, record an informational assessment and conclude that no PO amendments are warranted.`;
  }

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

  let turnId = turn.data.id;
  const executedTurnIds: string[] = [turnId];
  console.log(`   - Turn dispatched (${turnId}). Monitoring autonomous agent execution...`);

  // 6. Poll until turn finishes (allows sufficient time for multi-step agent reasoning & tool execution)
  let turnStatus = 'running';
  let completedTurn;
  const maxPollAttempts = 80;

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

  // Resilient retry: if model hit a transient provider overload, backoff and send continuation turn
  const errorMsg = String((completedTurn?.data?.state as any)?.message || '');
  if (turnStatus === 'error' && errorMsg.toLowerCase().includes('overloaded')) {
    console.log('\n⚠️ Model provider experienced transient overload. Backing off 4s and auto-resuming triage session...');
    await new Promise((r) => setTimeout(r, 4000));
    const retryTurn = await client.sessions.createTurn(sessionId, {
      input: [
        {
          type: 'user.message',
          content: 'Please resume and complete your disruption triage protocol from where you left off.',
        },
      ],
    });
    turnId = retryTurn.data.id;
    executedTurnIds.push(turnId);
    console.log(`   - Continuation turn dispatched (${turnId}). Polling until complete...`);

    for (let i = 0; i < maxPollAttempts; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      completedTurn = await client.sessions.getTurn(sessionId, turnId);
      turnStatus = completedTurn.data.state.status;

      if (turnStatus !== 'running') {
        console.log(`\n🏁 Continuation turn status finalized: ${turnStatus}`);
        break;
      }
      process.stdout.write('.');
    }
  }

  // Fix for Qodo #3: Strictly reject any non-done terminal state (e.g. cancelled, error)
  if (turnStatus !== 'done') {
    throw new Error(
      `❌ Turn failed with non-successful status '${turnStatus}': ${JSON.stringify(completedTurn?.data.state)}`
    );
  }

  // 7. Extract events and evaluate autonomous tool execution across all attempted turns (Fix for Qodo #4)
  const events: any[] = [];
  for (const tid of executedTurnIds) {
    const turnEvents = await client.sessions.listTurnEvents(sessionId, tid);
    events.push(...(turnEvents.data || []));
  }
  const toolsCalled: string[] = [];
  const responseParts: string[] = [];

  for (const ev of events) {
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

  // If responseParts is empty because the model concluded with a gated tool call,
  // extract the amendment evaluation from the propose_po_amendment tool arguments
  if (responseParts.length === 0) {
    for (const ev of events) {
      const anyEv = ev as any;
      const calls = anyEv.tool_calls || anyEv.toolCalls;
      if (Array.isArray(calls)) {
        for (const call of calls) {
          if (extractToolName(call) === 'propose_po_amendment') {
            try {
              const rawArgs = call.function?.arguments || call.arguments;
              const parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
              if (parsed.notes) {
                responseParts.push(`[AUTONOMOUS PO AMENDMENT PROPOSAL]: ${parsed.notes}`);
              } else {
                responseParts.push(`[AUTONOMOUS PO AMENDMENT PROPOSAL]: SKU ${parsed.sku}, Supplier ${parsed.supplier_id}, Quantity ${parsed.quantity}`);
              }
            } catch {}
          }
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
  const fixtureArgIdx = process.argv.indexOf('--fixture');
  const targetFixture =
    fixtureArgIdx !== -1 && process.argv[fixtureArgIdx + 1]
      ? path.resolve(process.cwd(), process.argv[fixtureArgIdx + 1])
      : undefined;

  injectDisruptionAlert(targetFixture)
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
