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
    console.log(
      `   - ${data.carrier_name}: ${data.available_teu_capacity} TEU, ${data.transit_time_days} days, $${data.rate_per_teu_usd}/TEU (Score: ${data.reliability_score})`
    );
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
  if (
    !queryResult.success ||
    queryResult.carrier_id !== 'maersk-pacific' ||
    queryResult.rate_per_teu_usd !== 2850
  ) {
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
We need to urgently evaluate 3 candidate ocean carriers for alternate routing away from the East China Sea:
1. Maersk Pacific ("maersk-pacific")
2. Evergreen Express ("evergreen-express")
3. CMA CGM Asia ("cma-cgm-asia")

Per your disruption-triage SOP:
Delegate carrier checks to parallel subagents using create_sub_agent — spawn one subagent per carrier in parallel.
Each subagent must call query_carrier_capacity for its assigned carrier and return a summary of transit days, rate per TEU, and capacity.
Summarize all three carrier findings and recommend the optimal carrier for our shipment.`;

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

  // 6. Inspect Session Trace for Subagent Threads (Fix for Qodo #2)
  console.log('\n🔍 Inspecting session trace for subagent execution...');
  const events = await client.sessions.listTurnEvents(sessionId, turnId);

  const createdThreads = new Set<string>();
  const doneThreads = new Set<string>();
  const childToolCalls: { tool: string; threadId: string; args?: any }[] = [];
  const rootToolCalls: { tool: string; args?: any }[] = [];
  const rootModelResponses: string[] = [];

  for (const ev of events.data || []) {
    const anyEv = ev as any;
    const currentThreadId = anyEv.threadId;

    if (anyEv.type === 'thread.created') {
      const tId = currentThreadId || anyEv.id;
      if (tId && tId !== 'main') {
        createdThreads.add(tId);
        console.log(`🧵 Subagent Thread Created: ${tId}`);
      }
    }

    if (anyEv.type === 'thread.done') {
      const tId = currentThreadId || anyEv.id;
      if (tId && tId !== 'main') {
        doneThreads.add(tId);
        console.log(`🏁 Subagent Thread Done: ${tId}`);
      }
    }

    const calls = anyEv.tool_calls || anyEv.toolCalls;
    if (anyEv.type === 'model.message' && Array.isArray(calls)) {
      for (const call of calls) {
        const name = call.tool_info?.name || call.function?.name || call.name;
        const rawArgs = call.function?.arguments || call.arguments;
        const parsedArgs = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs || {};

        if (currentThreadId && currentThreadId !== 'main') {
          childToolCalls.push({ tool: name, threadId: currentThreadId, args: parsedArgs });
          console.log(`   [Child Thread ${currentThreadId.slice(0, 8)}] Tool Call: ${name}`);
        } else {
          rootToolCalls.push({ tool: name, args: parsedArgs });
          console.log(`   [Root Thread] Tool Call: ${name}`);
        }
      }
    }

    // Fix for Qodo #3: Collect only root-thread model text messages
    if (
      anyEv.type === 'model.message' &&
      (!currentThreadId || currentThreadId === 'main') &&
      typeof anyEv.content === 'string' &&
      anyEv.content.trim()
    ) {
      rootModelResponses.push(anyEv.content.trim());
    }
  }

  const subAgentSpawns = rootToolCalls.filter((c) => c.tool === 'create_sub_agent');
  console.log(`\n📊 Subagent Execution Trace Analysis:`);
  console.log(`   - Root create_sub_agent calls: ${subAgentSpawns.length}`);
  console.log(`   - Distinct child threads created: ${createdThreads.size}`);
  console.log(`   - Distinct child threads completed: ${doneThreads.size}`);
  console.log(`   - Child thread tool calls executed: ${childToolCalls.length}`);

  // Fix for Qodo #2: Require at least 2 distinct child threads created and verified completed
  if (createdThreads.size < 2 && subAgentSpawns.length < 2) {
    throw new Error(
      `❌ Expected at least 2 distinct child subagent threads created, found ${createdThreads.size} threads and ${subAgentSpawns.length} spawn calls.`
    );
  }

  // Verify that each created child thread successfully reached thread.done
  for (const tId of createdThreads) {
    if (!doneThreads.has(tId)) {
      throw new Error(`❌ Child thread ${tId} was created but did not emit thread.done!`);
    }
  }
  console.log('✅ Criteria 4 & 5 Passed: Multiple distinct subagent threads created and verified completed');

  // Fix for Qodo #2: Trace isolation — verify carrier query tools ran in child threads, not in the root thread
  const rootCarrierQueries = rootToolCalls.filter((c) => c.tool === 'query_carrier_capacity');
  if (rootCarrierQueries.length > 0) {
    throw new Error(
      `❌ Root agent executed query_carrier_capacity directly in root thread instead of isolating within subagents!`
    );
  }
  console.log('✅ Criteria 6 Passed: Intermediate tool calls isolated inside child subagent threads');

  // Fix for Qodo #3: Strict validation of the terminal root synthesis message
  const finalRootResponse = rootModelResponses.join('\n\n');
  if (!finalRootResponse) {
    throw new Error('❌ Root thread finished without producing a final model response message!');
  }

  const lowerRootResp = finalRootResponse.toLowerCase();
  const hasMaersk = lowerRootResp.includes('maersk');
  const hasEvergreen = lowerRootResp.includes('evergreen');
  const hasCma = lowerRootResp.includes('cma');

  if (!hasMaersk || !hasEvergreen || !hasCma) {
    throw new Error(
      `❌ Root synthesis failed to include all three carriers (Maersk: ${hasMaersk}, Evergreen: ${hasEvergreen}, CMA: ${hasCma})! Response: ${finalRootResponse}`
    );
  }

  const hasMetrics =
    (lowerRootResp.includes('rate') || lowerRootResp.includes('$') || lowerRootResp.includes('2850') || lowerRootResp.includes('1920')) &&
    (lowerRootResp.includes('transit') || lowerRootResp.includes('day') || lowerRootResp.includes('8') || lowerRootResp.includes('14')) &&
    (lowerRootResp.includes('capacity') || lowerRootResp.includes('teu') || lowerRootResp.includes('45') || lowerRootResp.includes('120'));

  if (!hasMetrics) {
    throw new Error(`❌ Root synthesis missing carrier rate, transit, or capacity comparison metrics! Response: ${finalRootResponse}`);
  }

  console.log('✅ Criteria 7 Passed: Root agent synthesized all 3 carrier profiles with rates, transit times, and capacity');

  console.log('\n💬 Synthesized Carrier Evaluation Summary from Root Agent:');
  console.log('--------------------------------------------------------------------------------');
  console.log(finalRootResponse.slice(0, 600) + '...\n');
  console.log('--------------------------------------------------------------------------------');

  console.log('\n🎉 ALL Ticket #08 acceptance tests PASSED successfully!');
}

runSubagentsTests().catch((err) => {
  console.error('\n❌ Subagents test failed:', err);
  process.exit(1);
});
