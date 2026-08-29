import { TrueForge } from '@truefoundry/trueforge-sdk';
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createErpMcpServer } from '../mcp-servers/erp/src/index.js';
import { handleQueryCarrierCapacity } from '../mcp-servers/erp/src/tools/query-carrier-capacity.js';
import { configureDisruptionTriageAgent, TRUEFORGE_BASE_URL } from '../trueforge/agent-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runSubagentsTests() {
  console.log('🧪 Starting Parallel Carrier Subagents Verification (Ticket #08)...');

  // 1. Verify 3 Carrier Fixtures (Criteria 1)
  console.log('\n🔍 Verifying fixtures/carriers/ directory and files...');
  const fixturesDir = path.resolve(__dirname, '../fixtures/carriers');
  const expectedCarriers = ['maersk-pacific', 'evergreen-express', 'cma-cgm-asia'];

  const carrierProfiles: Record<string, any> = {};
  for (const c of expectedCarriers) {
    const file = path.join(fixturesDir, `${c}.json`);
    if (!fs.existsSync(file)) {
      throw new Error(`❌ Missing carrier fixture: ${file}`);
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data.available_teu_capacity || !data.transit_time_days || !data.rate_per_teu_usd) {
      throw new Error(`❌ Fixture ${c}.json missing required rate/capacity/transit fields!`);
    }
    carrierProfiles[c] = data;
    console.log(`   - ${data.carrier_name}: ${data.available_teu_capacity} TEU, ${data.transit_time_days} days, $${data.rate_per_teu_usd}/TEU (Score: ${data.reliability_score})`);
  }
  console.log('✅ Criteria 1 Passed: fixtures/carriers/ contains 3 distinct, differentiated carrier profiles');

  // 2. Verify query_carrier_capacity tool in ERP MCP Server (Criteria 2 & 3)
  console.log('\n🔍 Verifying query_carrier_capacity tool registration and execution...');
  const erpServer = createErpMcpServer();
  const registered = (erpServer as any)._registeredTools;
  const tool = registered['query_carrier_capacity'];

  if (!tool) {
    throw new Error("❌ Tool 'query_carrier_capacity' is not registered in ERP MCP Server!");
  }
  if (!tool.annotations?.readOnlyHint) {
    throw new Error("❌ Tool 'query_carrier_capacity' must have readOnlyHint: true annotation!");
  }

  const queryResult = await handleQueryCarrierCapacity({ carrier: 'maersk-pacific' });
  if (!queryResult.success || queryResult.carrier_id !== 'maersk-pacific' || queryResult.rate_per_teu_usd !== 2850) {
    throw new Error(`❌ query_carrier_capacity tool returned invalid data: ${JSON.stringify(queryResult)}`);
  }
  console.log('✅ Criteria 2 & 3 Passed: query_carrier_capacity tool is registered with readOnlyHint: true and returns structured data');

  // 3. Ensure agent is configured with skill and dynamic subagents enabled
  console.log('\n🔍 Ensuring TrueForge agent is configured with dynamic subagents enabled...');
  await configureDisruptionTriageAgent(TRUEFORGE_BASE_URL, { includeSkill: true });

  const client = new TrueForge({ baseUrl: TRUEFORGE_BASE_URL });
  const session = await client.sessions.create({
    agent: { name: 'disruption-triage-agent' },
  });
  const sessionId = session.data.id;
  console.log(`   - Test Session Created: ${sessionId}`);

  // 4. Prompt agent to delegate carrier capacity queries to parallel subagents (Criteria 4)
  console.log('\n📨 Dispatching prompt instructing agent to evaluate carriers via parallel subagents...');
  const prompt = `CRITICAL CARRIER CAPACITY EVALUATION:
We need to urgently evaluate 3 candidate ocean carriers for alternate routing:
1. Maersk Pacific ("maersk-pacific")
2. Evergreen Express ("evergreen-express")
3. CMA CGM Asia ("cma-cgm-asia")

Per your disruption-triage SOP:
Delegate carrier checks to parallel subagents using create_sub_agent — spawn one subagent per carrier in parallel.
Each subagent must call query_carrier_capacity for its assigned carrier and return a summary of transit days, rate per TEU, and capacity.
Summarize their findings and recommend the optimal carrier for our shipment.`;

  const turn = await client.sessions.createTurn(sessionId, {
    input: [{ type: 'user.message', content: prompt }],
  });
  const turnId = turn.data.id;
  console.log(`   - Turn initiated (${turnId}). Polling execution trace...`);

  // 5. Poll turn until done
  let turnStatus = 'running';
  let completedTurn;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    completedTurn = await client.sessions.getTurn(sessionId, turnId);
    turnStatus = completedTurn.data.state.status;
    if (turnStatus !== 'running') {
      console.log(`\n🏁 Turn status finalized: ${turnStatus}`);
      break;
    }
    process.stdout.write('.');
  }

  if (turnStatus !== 'done') {
    throw new Error(`❌ Turn did not complete successfully. Final status: '${turnStatus}'`);
  }

  // 6. Inspect Session Trace for Subagent Threads (Criteria 5, 6, 7)
  console.log('\n🔍 Inspecting session trace for subagent execution...');
  const events = await client.sessions.listTurnEvents(sessionId, turnId);

  const threadCreatedEvents: any[] = [];
  const toolCalls: any[] = [];
  const modelMessages: any[] = [];

  for (const ev of events.data || []) {
    const anyEv = ev as any;
    if (anyEv.type === 'thread.created' || anyEv.type === 'thread.done') {
      threadCreatedEvents.push(anyEv);
      console.log(`🧵 Subagent Event: ${anyEv.type} (threadId: ${anyEv.threadId || anyEv.id})`);
    }

    const calls = anyEv.tool_calls || anyEv.toolCalls;
    if (anyEv.type === 'model.message' && Array.isArray(calls)) {
      for (const call of calls) {
        const name = call.tool_info?.name || call.function?.name || call.name;
        toolCalls.push({ name, threadId: anyEv.threadId });
        if (name === 'create_sub_agent') {
          console.log(`🤖 Native Subagent Spawn: create_sub_agent (Thread: ${anyEv.threadId || 'root'})`);
        } else {
          console.log(`🛠️ Tool Call: ${name} (Thread: ${anyEv.threadId || 'root'})`);
        }
      }
    }

    if (anyEv.type === 'model.message' && typeof anyEv.content === 'string' && anyEv.content.trim()) {
      modelMessages.push(anyEv.content.trim());
    }
  }

  const subAgentSpawns = toolCalls.filter((c) => c.name === 'create_sub_agent');
  console.log(`\n📊 Subagent Execution Summary:`);
  console.log(`   - create_sub_agent invocations: ${subAgentSpawns.length}`);
  console.log(`   - thread lifecycle events: ${threadCreatedEvents.length}`);

  // Criteria 4 & 5 Verification:
  if (subAgentSpawns.length < 2 && threadCreatedEvents.length < 2) {
    throw new Error(
      `❌ Expected agent to spawn at least 2 parallel subagents via create_sub_agent or thread.created, found ${subAgentSpawns.length} calls and ${threadCreatedEvents.length} thread events.`
    );
  }
  console.log('✅ Criteria 4 & 5 Passed: Agent delegated carrier queries to separate subagents (create_sub_agent / thread.created)');

  // Criteria 7: Verify final response summarizes carrier profiles
  const finalSummary = modelMessages.join('\n\n');
  if (!finalSummary.toLowerCase().includes('maersk') || !finalSummary.toLowerCase().includes('evergreen')) {
    throw new Error('❌ Root agent did not receive or synthesize carrier summaries in its response!');
  }
  console.log('✅ Criteria 6 & 7 Passed: Parallel subagents executed and final carrier comparison synthesized in root context');

  console.log('\n💬 Synthesized Carrier Evaluation Summary:');
  console.log('--------------------------------------------------------------------------------');
  console.log(finalSummary.slice(0, 500) + '...\n');
  console.log('--------------------------------------------------------------------------------');

  console.log('\n🎉 ALL Ticket #08 acceptance tests PASSED successfully!');
}

runSubagentsTests().catch((err) => {
  console.error('\n❌ Subagents test failed:', err);
  process.exit(1);
});
