import { TrueForge } from '@truefoundry/trueforge-sdk';
import 'dotenv/config';
import { TRUEFORGE_BASE_URL } from './agent-config.js';

async function runAgentWiringTests() {
  console.log('🧪 Starting TrueForge Agent Wiring Verification (Ticket #05)...');
  const client = new TrueForge({ baseUrl: TRUEFORGE_BASE_URL });

  // 1. Verify Agent is in Library
  console.log('\n🔍 Checking Agent in TrueForge Agent Library...');
  const agents = await client.agents.list();
  const agent = agents.data.find((a) => a.name === 'disruption-triage-agent');

  if (!agent) {
    throw new Error("❌ Agent 'disruption-triage-agent' not found in TrueForge Agent Library!");
  }
  console.log(`✅ Criteria Passed: Agent '${agent.name}' (ID: ${agent.id}) is registered`);

  // 2. Verify MCP Server Attachment and Approval Gating
  console.log('\n🔍 Verifying MCP server configuration and gating...');
  const mcpServers = agent.manifest.mcpServers || [];
  const erpMcp = mcpServers.find((m) => m.name === 'erp-mcp');
  const telemetryMcp = mcpServers.find((m) => m.name === 'telemetry-mcp');

  if (!erpMcp) {
    throw new Error("❌ 'erp-mcp' connector not attached to agent!");
  }
  if (!telemetryMcp) {
    throw new Error("❌ 'telemetry-mcp' connector not attached to agent!");
  }

  const approvalTools = erpMcp.requireApprovalForTools || [];
  if (!approvalTools.includes('propose_po_amendment') && !approvalTools.includes('@write')) {
    throw new Error(
      `❌ ERP MCP write tools must require approval. Current: ${JSON.stringify(approvalTools)}`
    );
  }
  console.log(`✅ Criteria Passed: erp-mcp attached with write approval gate on ${JSON.stringify(approvalTools)}`);
  console.log(`✅ Criteria Passed: telemetry-mcp attached for autonomous telemetry`);

  // 3. Verify Sandbox, SubAgents, and GenUI Config
  console.log('\n🔍 Verifying Runtime Configuration...');
  const config = agent.manifest.config || {};
  if (!config.sandbox?.enabled) {
    throw new Error('❌ Sandbox is not enabled on agent configuration!');
  }
  if (!config.dynamicSubAgents?.enabled) {
    throw new Error('❌ Dynamic subagents are not enabled on agent configuration!');
  }
  if (!config.generativeUi?.enabled) {
    throw new Error('❌ Generative UI is not enabled on agent configuration!');
  }
  console.log('✅ Criteria Passed: Sandbox, Subagents, and Generative UI are enabled');

  // 4. Test Session Lifecycle and Chat Execution
  console.log('\n🔍 Testing Session creation and model communication...');
  const session = await client.sessions.create({
    agent: { name: 'disruption-triage-agent' },
  });

  const sessionId = session.data.id;
  console.log(`   - Created Test Session: ${sessionId}`);

  const turn = await client.sessions.createTurn(sessionId, {
    input: [
      {
        type: 'user.message',
        content: 'Briefly acknowledge system readiness for logistics disruption triage.',
      },
    ],
  });

  const turnId = turn.data.id;
  console.log(`   - Turn initiated (${turnId}). Polling status...`);

  let turnStatus = 'running';
  let completedTurn;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    completedTurn = await client.sessions.getTurn(sessionId, turnId);
    turnStatus = completedTurn.data.state.status;
    if (turnStatus !== 'running') break;
  }

  if (turnStatus !== 'done') {
    throw new Error(`❌ Turn failed with status: ${turnStatus}. State: ${JSON.stringify(completedTurn?.data.state)}`);
  }

  const events = await client.sessions.listTurnEvents(sessionId, turnId);
  const messageEvents = events.data.filter(
    (e: any) => e.type === 'model.message' && typeof e.content === 'string'
  );
  const agentMessage = messageEvents[messageEvents.length - 1] as any;
  console.log(`✅ Criteria Passed: Model responded successfully:`);
  console.log(`   Response: "${(agentMessage?.content as string)?.slice(0, 140)}..."`);

  // 5. Test Session Persistence
  console.log('\n🔍 Verifying Session Persistence in TrueForge...');
  const retrievedSession = await client.sessions.get(sessionId);
  if (retrievedSession.data.id !== sessionId) {
    throw new Error('❌ Session failed persistence check!');
  }
  console.log(`✅ Criteria Passed: Session ${sessionId} retrieved successfully from persistent store`);

  console.log('\n🎉 ALL Ticket #05 acceptance tests PASSED successfully!');
}

runAgentWiringTests().catch((err) => {
  console.error('\n❌ TrueForge agent verification failed:', err);
  process.exit(1);
});
