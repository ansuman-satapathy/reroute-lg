import { TrueForge } from '@truefoundry/trueforge-sdk';
import 'dotenv/config';

export const TRUEFORGE_BASE_URL =
  process.env.TRUEFORGE_URL || process.env.TRUEFORGE_BASE_URL || 'http://localhost:8790';

export const AGENT_INSTRUCTIONS = `You are the Autonomous Supply-Chain Disruption Triage Specialist for marine and industrial manufacturing.

Your primary mission is to detect supply-chain disruptions in real time, assess buffer vulnerability, identify qualified alternate suppliers, compute cost-optimal rerouting, and safely execute purchase order amendments under strict human authorization.

### Operational Workflow (Standard Operating Procedure):
1. **Disruption Assessment**:
   - Query live maritime weather (\`get_weather_alerts\`) and maritime news (\`get_news_disruptions\`) for impacted transit corridors (e.g. East China Sea, Ningbo, Shanghai).
   - Synthesize operational severity using \`assess_disruption\`. If severity is HIGH or MEDIUM, initiate immediate triage.

2. **Inventory Vulnerability Analysis**:
   - Query \`read_inventory\` for the affected component (e.g. SKU-4471 Marine Propeller Shaft Bearing).
   - Calculate Days of Supply (DoS): Current Stock / Daily Burn Rate.
   - Determine the exact projected stockout date based on current consumption.

3. **Alternate Supplier Discovery & Scoring**:
   - Query \`read_suppliers\` for candidates offering the affected SKU.
   - Disqualify any suppliers located in the disrupted corridor.
   - For viable alternates, evaluate:
     * Quoted Lead Time (must arrive BEFORE stockout date)
     * Unit Cost & Total Batch Cost
     * Reliability Score & Historical Performance
   - Use the Daytona sandbox (\`exec\`) to run Python optimization/scoring models when comparing multi-supplier trade-offs.

4. **Human Approval Gating**:
   - When amending an order, propose the change using \`propose_po_amendment\`.
   - Provide a clear, comprehensive breakdown of:
     * Why the primary supplier is compromised
     * Selected alternate supplier (lead time, unit cost, reliability score)
     * Financial variance vs. primary supplier
     * Stockout date averted
   - TrueForge will automatically pause execution and present the human operator with an Allow/Deny approval gate.
   - If the operator approves, the order commits with status 'approved'.
   - If the operator denies the amendment, capture their denial rationale and record an audit entry using \`record_po_rejection\`.

5. **Ledger Integrity**:
   - You NEVER attempt direct mutations to inventory or supplier catalog tables.
   - All actions are logged and auditable.
`;

export async function configureDisruptionTriageAgent(
  baseUrl = TRUEFORGE_BASE_URL
): Promise<any> {
  console.log(`🔌 Connecting to TrueForge instance at: ${baseUrl}`);
  const client = new TrueForge({ baseUrl });

  // 1. Discover available models
  const modelsResponse = await client.models.list();
  const availableModels = modelsResponse.data || [];
  console.log(`📋 Found ${availableModels.length} configured model(s) in TrueForge.`);

  if (availableModels.length === 0) {
    throw new Error(
      'No models configured in TrueForge. Please configure a model in TrueForge Settings.'
    );
  }

  // Prefer nvidia-nim, claude, or openai, fallback to first available
  const preferredModel =
    availableModels.find((m) => m.name.includes('nvidia') || m.name.includes('nim')) ||
    availableModels.find((m) => m.name.includes('claude') || m.name.includes('gpt')) ||
    availableModels[0];

  console.log(`🎯 Selected model: ${preferredModel.name} (${preferredModel.modelId})`);

  // 2. Register MCP Servers (Connectors)
  const erpPort = process.env.ERP_MCP_PORT || '3001';
  const telemetryPort = process.env.TELEMETRY_MCP_PORT || '3002';

  console.log('\n📦 Registering / Updating MCP Server Connectors...');

  // ERP MCP Server
  const erpServer = await client.settings.mcpServers.createOrUpdate({
    manifest: {
      name: 'erp-mcp',
      description: 'ERP database connector for inventory, suppliers, and purchase order amendments',
      type: 'remote',
      url: `http://localhost:${erpPort}/sse`,
    },
  });
  console.log(`✅ Registered ERP MCP Server: http://localhost:${erpPort}/sse (status: ${erpServer.data.name})`);

  // Telemetry MCP Server
  const telemetryServer = await client.settings.mcpServers.createOrUpdate({
    manifest: {
      name: 'telemetry-mcp',
      description: 'Live marine weather metrics (Open-Meteo) and maritime disruption news',
      type: 'remote',
      url: `http://localhost:${telemetryPort}/sse`,
    },
  });
  console.log(`✅ Registered Telemetry MCP Server: http://localhost:${telemetryPort}/sse (status: ${telemetryServer.data.name})`);

  // 3. Create or Update Agent 'disruption-triage-agent'
  console.log('\n🤖 Configuring disruption-triage-agent in Agent Library...');

  const existingAgents = await client.agents.list();
  const existingAgent = existingAgents.data.find(
    (a) => a.name === 'disruption-triage-agent'
  );

  const agentManifest = {
    model: {
      name: preferredModel.name,
    },
    instructions: AGENT_INSTRUCTIONS,
    mcpServers: [
      {
        name: 'erp-mcp',
        enableTools: ['@all'],
        requireApprovalForTools: ['propose_po_amendment'],
        preload: true,
      },
      {
        name: 'telemetry-mcp',
        enableTools: ['@all'],
        requireApprovalForTools: [],
        preload: true,
      },
    ],
    config: {
      iterationLimit: 100,
      sandbox: {
        enabled: true,
        fileDownloads: true,
      },
      dynamicSubAgents: {
        enabled: true,
      },
      generativeUi: {
        enabled: true,
      },
      askUserQuestions: {
        enabled: true,
      },
    },
  };

  let configuredAgent;
  if (existingAgent) {
    console.log(`🔄 Updating existing agent [${existingAgent.id}]...`);
    configuredAgent = await client.agents.update(existingAgent.id, {
      manifest: agentManifest,
    });
  } else {
    console.log(`✨ Creating new agent 'disruption-triage-agent'...`);
    configuredAgent = await client.agents.create({
      name: 'disruption-triage-agent',
      manifest: agentManifest,
    });
  }

  console.log(`\n🎉 Agent successfully wired in TrueForge:`);
  console.log(`   - Agent ID: ${configuredAgent.data.id}`);
  console.log(`   - Agent Name: ${configuredAgent.data.name}`);
  console.log(`   - Model: ${configuredAgent.data.manifest.model.name}`);
  console.log(`   - ERP Tools Gated: propose_po_amendment (Approval Required)`);
  console.log(`   - Telemetry Tools: Ungated (Autonomous)`);
  console.log(`   - Sandbox: Enabled`);
  console.log(`   - Subagents: Enabled`);
  console.log(`   - Generative UI: Enabled`);

  return configuredAgent.data;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  configureDisruptionTriageAgent().catch((err) => {
    console.error('❌ Agent configuration failed:', err);
    process.exit(1);
  });
}
