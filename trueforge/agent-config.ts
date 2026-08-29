import { TrueForge } from '@truefoundry/trueforge-sdk';
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TRUEFORGE_BASE_URL =
  process.env.TRUEFORGE_URL || process.env.TRUEFORGE_BASE_URL || 'http://localhost:8790';

// Read skill file directly for complete prompt fidelity
const skillFilePath = path.resolve(__dirname, '../skills/disruption-triage/SKILL.md');
export const SKILL_CONTENT = fs.existsSync(skillFilePath)
  ? fs.readFileSync(skillFilePath, 'utf8')
  : '';

export const BASE_AGENT_INSTRUCTIONS = `You are the Autonomous Supply-Chain Disruption Triage Specialist for marine and industrial manufacturing.

Your primary mission is to detect supply-chain disruptions in real time, assess buffer vulnerability, identify qualified alternate suppliers, compute cost-optimal rerouting, and safely execute purchase order amendments under strict human authorization.

${SKILL_CONTENT}
`;

export async function configureDisruptionTriageAgent(
  baseUrl = TRUEFORGE_BASE_URL,
  options: { includeSkill?: boolean } = { includeSkill: true }
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

  const preferredModel =
    availableModels.find((m) => m.name.includes('nvidia') || m.name.includes('nim')) ||
    availableModels.find((m) => m.name.includes('claude') || m.name.includes('gpt')) ||
    availableModels[0];

  console.log(`🎯 Selected model: ${preferredModel.name} (${preferredModel.modelId})`);

  // 2. Register MCP Servers (Connectors)
  const erpPort = process.env.ERP_MCP_PORT || '3001';
  const telemetryPort = process.env.TELEMETRY_MCP_PORT || '3002';
  const erpMcpUrl = process.env.ERP_MCP_URL || `http://localhost:${erpPort}/sse`;
  const telemetryMcpUrl = process.env.TELEMETRY_MCP_URL || `http://localhost:${telemetryPort}/sse`;

  console.log('\n📦 Registering / Updating MCP Server Connectors...');

  const erpServer = await client.settings.mcpServers.createOrUpdate({
    manifest: {
      name: 'erp-mcp',
      description: 'ERP database connector for inventory, suppliers, and purchase order amendments',
      type: 'remote',
      url: erpMcpUrl,
    },
  });
  console.log(`✅ Registered ERP MCP Server: ${erpMcpUrl} (status: ${erpServer.data.name})`);

  const telemetryServer = await client.settings.mcpServers.createOrUpdate({
    manifest: {
      name: 'telemetry-mcp',
      description: 'Live marine weather metrics (Open-Meteo) and maritime disruption news',
      type: 'remote',
      url: telemetryMcpUrl,
    },
  });
  console.log(`✅ Registered Telemetry MCP Server: ${telemetryMcpUrl} (status: ${telemetryServer.data.name})`);

  // 3. Register Skill in TrueForge Settings if requested
  const includeSkill = options.includeSkill ?? true;
  let attachedSkills: any[] = [];

  if (includeSkill) {
    console.log('\n🧠 Registering Disruption-Triage Skill in TrueForge Settings...');
    // Fix for Qodo #3: Do not swallow registration errors; fail early if registration fails
    const registeredSkill = await client.settings.skills.createOrUpdate({
      manifest: {
        name: 'disruption-triage',
        description:
          'Standard operating procedure, routing rules, cost bands, and approval gate protocols for logistics disruption triage',
        type: 'git',
        url: 'https://github.com/ansuman-satapathy/reroute-lg',
        ref: 'main',
        path: 'skills/disruption-triage',
      },
    });
    console.log(`✅ Registered Skill in Settings: ${registeredSkill.data.name}`);
    attachedSkills = [{ name: 'disruption-triage' }];
  }

  // 4. Create or Update Agent 'disruption-triage-agent'
  console.log('\n🤖 Configuring disruption-triage-agent in Agent Library...');

  const existingAgents = await client.agents.list();
  const existingAgent = existingAgents.data.find(
    (a) => a.name === 'disruption-triage-agent'
  );

  const instructions = includeSkill
    ? BASE_AGENT_INSTRUCTIONS
    : 'You are a general logistics assistant. Respond to user queries about supply chains without following any special triage SOP or cost-band enforcement.';

  const agentManifest: any = {
    model: {
      name: preferredModel.name,
    },
    instructions,
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

  if (includeSkill && attachedSkills.length > 0) {
    agentManifest.skills = attachedSkills;
  }

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
  console.log(`   - Skill Attached: ${includeSkill ? 'Yes (disruption-triage)' : 'No (baseline)'}`);
  console.log(`   - ERP Tools Gated: propose_po_amendment (Approval Required)`);

  return configuredAgent.data;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  configureDisruptionTriageAgent().catch((err) => {
    console.error('❌ Agent configuration failed:', err);
    process.exit(1);
  });
}
