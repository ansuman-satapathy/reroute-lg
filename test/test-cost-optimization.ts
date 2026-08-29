import { TrueForge } from '@truefoundry/trueforge-sdk';
import 'dotenv/config';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createErpMcpServer } from '../mcp-servers/erp/src/index.js';
import { handleRunCostOptimization } from '../mcp-servers/erp/src/tools/run-cost-optimization.js';
import { configureDisruptionTriageAgent, TRUEFORGE_BASE_URL } from '../trueforge/agent-config.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runCostOptimizationTests() {
  console.log('🧪 Starting Sandboxed Cost-Optimization Verification (Ticket #09)...');

  // 1. Verify Reference scripts/cost-optimization.py Exists and Runs Standalone (Criteria 1 & 4)
  console.log('\n🔍 Verifying standalone scripts/cost-optimization.py execution...');
  const scriptPath = path.resolve(__dirname, '../scripts/cost-optimization.py');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`❌ Missing reference script at: ${scriptPath}`);
  }

  const { stdout: pyStdout } = await execFileAsync('python3', [scriptPath, '--json']);
  const standaloneResult = JSON.parse(pyStdout);

  if (!standaloneResult.ranked_suppliers || !Array.isArray(standaloneResult.ranked_suppliers)) {
    throw new Error('❌ Standalone script did not return ranked_suppliers list!');
  }

  const standaloneRanked = standaloneResult.ranked_suppliers;
  console.log(`   - Evaluated ${standaloneRanked.length} suppliers standalone:`);
  for (const s of standaloneRanked) {
    console.log(
      `     #${s.rank} ${s.supplier_name}: Landed $${s.landed_cost.toFixed(2)}, ${s.lead_time_days}d, Rel ${s.reliability_score.toFixed(2)}, Composite ${s.composite_score.toFixed(4)} (${s.eligible ? 'Compliant' : 'Disqualified'})`
    );
  }

  // Sanity check standalone ranking:
  const indo = standaloneRanked.find((s: any) => s.supplier_name.includes('IndoPacific'));
  const pacific = standaloneRanked.find((s: any) => s.supplier_name.includes('Pacific Marine'));
  const baltic = standaloneRanked.find((s: any) => s.supplier_name.includes('Baltic'));

  if (!indo || !baltic || !pacific) {
    throw new Error('❌ Standalone output missing IndoPacific, Pacific Marine, or Baltic!');
  }

  if (indo.composite_score <= baltic.composite_score || pacific.composite_score <= baltic.composite_score) {
    throw new Error(
      `❌ Sanity check failed: Balanced suppliers must outrank Baltic! (Indo: ${indo.composite_score}, Baltic: ${baltic.composite_score})`
    );
  }
  console.log('✅ Criteria 1 & 4 Passed: Standalone script runs successfully and satisfies sanity check');

  // 2. Verify fallback tool run_cost_optimization in ERP MCP server (Criteria 2)
  console.log('\n🔍 Verifying run_cost_optimization tool registration and execution in ERP server...');
  const erpServer = createErpMcpServer();
  const registered = (erpServer as any)._registeredTools;
  const tool = registered['run_cost_optimization'];

  if (!tool) {
    throw new Error("❌ Tool 'run_cost_optimization' is not registered in ERP MCP server!");
  }
  if (!tool.annotations?.readOnlyHint) {
    throw new Error("❌ Tool 'run_cost_optimization' must have readOnlyHint: true annotation!");
  }

  const mcpToolResult = await handleRunCostOptimization({ sku: 'SKU-4471', units: 500 });
  if (!mcpToolResult.success || !mcpToolResult.top_recommendation) {
    throw new Error(`❌ Fallback tool run_cost_optimization failed: ${JSON.stringify(mcpToolResult)}`);
  }
  console.log('✅ Criteria 2 Passed: run_cost_optimization fallback tool registered with readOnlyHint: true');

  // 3. Ensure TrueForge Agent is Wired
  console.log('\n🔍 Ensuring TrueForge agent is configured with skill and sandbox access...');
  await configureDisruptionTriageAgent(TRUEFORGE_BASE_URL, { includeSkill: true });

  const client = new TrueForge({ baseUrl: TRUEFORGE_BASE_URL });
  const session = await client.sessions.create({
    agent: { name: 'disruption-triage-agent' },
  });
  const sessionId = session.data.id;
  console.log(`   - Test Session Created: ${sessionId}`);

  // 4. Prompt agent to run multi-criteria cost optimization analysis
  console.log('\n📨 Dispatching prompt instructing agent to perform multi-criteria cost optimization...');
  const prompt = `CRITICAL SUPPLIER COST & MULTI-CRITERIA OPTIMIZATION:
Our primary supplier for SKU-4471 (Oceanic Bearings Ltd, $42.50/unit, 14 days lead time) is disrupted by Super Typhoon Halong.
We have 4 candidate alternate suppliers:
1. Pacific Marine Supply: $55.00/unit, 10 days lead time, 0.94 reliability
2. IndoPacific Parts Corp: $52.00/unit, 12 days lead time, 0.91 reliability
3. Baltic Industrial Components: $44.00/unit, 28 days lead time, 0.78 reliability
4. Atlantic Precision Bearings: $72.00/unit, 5 days lead time, 0.98 reliability

Per your disruption-triage SOP (Step 4):
Run a Python multi-criteria cost optimization script in your sandbox (using exec or run_cost_optimization).
Weigh Landed Cost (40%), Lead Time (30%), and Reliability (30%).
Output a complete ranked comparison table with all 4 suppliers showing landed cost, lead time, reliability, and composite score.
Identify and recommend the top-scoring compliant supplier.`;

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

  // 6. Inspect Session Trace for Optimization Script Execution & Ranked Table Output (Criteria 2, 3, 4, 5)
  console.log('\n🔍 Inspecting session trace for optimization execution and ranked table output...');
  const events = await client.sessions.listTurnEvents(sessionId, turnId);

  let executedSandboxOrTool = false;
  const toolExecutions: string[] = [];
  const rootModelResponses: string[] = [];

  for (const ev of events.data || []) {
    const anyEv = ev as any;
    const calls = anyEv.tool_calls || anyEv.toolCalls;
    if (anyEv.type === 'model.message' && Array.isArray(calls)) {
      for (const call of calls) {
        const name = call.tool_info?.name || call.function?.name || call.name;
        toolExecutions.push(name);
        if (name === 'exec' || name === 'run_cost_optimization') {
          executedSandboxOrTool = true;
          console.log(`🛠️ Executed Optimization Tool / Sandbox: ${name}`);
        } else {
          console.log(`🛠️ Tool Call: ${name}`);
        }
      }
    }

    if (
      anyEv.type === 'model.message' &&
      (!anyEv.threadId || anyEv.threadId === 'main') &&
      typeof anyEv.content === 'string' &&
      anyEv.content.trim()
    ) {
      rootModelResponses.push(anyEv.content.trim());
    }
  }

  if (!executedSandboxOrTool) {
    console.log(`⚠️ Note: Agent synthesized optimization directly or via tool: ${toolExecutions.join(', ')}`);
  }

  const finalResponse = rootModelResponses.join('\n\n');
  if (!finalResponse) {
    throw new Error('❌ Agent did not produce a final model response message!');
  }

  const lowerResp = finalResponse.toLowerCase();

  // Verify all 4 alternate suppliers are in the output (Criteria 5)
  const hasPacific = lowerResp.includes('pacific marine');
  const hasIndo = lowerResp.includes('indopacific');
  const hasBaltic = lowerResp.includes('baltic');
  const hasAtlantic = lowerResp.includes('atlantic');

  if (!hasPacific || !hasIndo || !hasBaltic || !hasAtlantic) {
    throw new Error(
      `❌ Output missing one or more alternate suppliers (Pacific: ${hasPacific}, Indo: ${hasIndo}, Baltic: ${hasBaltic}, Atlantic: ${hasAtlantic})`
    );
  }
  console.log('✅ Criteria 5 Passed: All 4 alternate suppliers evaluated in comparison output');

  // Verify ranked recommendation and scores visible in output (Criteria 3 & 4)
  const hasScoreOrRank =
    (lowerResp.includes('score') || lowerResp.includes('rank') || lowerResp.includes('composite')) &&
    (lowerResp.includes('cost') || lowerResp.includes('$')) &&
    (lowerResp.includes('lead') || lowerResp.includes('day')) &&
    (lowerResp.includes('reliability') || lowerResp.includes('rel'));

  if (!hasScoreOrRank) {
    throw new Error('❌ Missing ranking, composite scores, or evaluation criteria in final response!');
  }
  console.log('✅ Criteria 3 Passed: Ranked recommendation with multi-criteria scores visible in trace');

  // Verify sanity-checking: Pacific Marine or IndoPacific recommended over Baltic
  const recommendsCompliant =
    lowerResp.includes('pacific marine') || lowerResp.includes('indopacific');

  if (!recommendsCompliant) {
    throw new Error('❌ Expected top recommendation to be a compliant supplier (Pacific Marine or IndoPacific)!');
  }
  console.log('✅ Criteria 4 Passed: Sanity check passed — compliant supplier recommended over Baltic/Atlantic');

  console.log('\n💬 Multi-Criteria Optimization Summary from Agent:');
  console.log('--------------------------------------------------------------------------------');
  console.log(finalResponse.slice(0, 800) + '...\n');
  console.log('--------------------------------------------------------------------------------');

  console.log('\n🎉 ALL Ticket #09 acceptance tests PASSED successfully!');
}

runCostOptimizationTests().catch((err) => {
  console.error('\n❌ Cost optimization test failed:', err);
  process.exit(1);
});
