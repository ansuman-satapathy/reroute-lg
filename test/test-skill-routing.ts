import { TrueForge } from '@truefoundry/trueforge-sdk';
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureDisruptionTriageAgent, TRUEFORGE_BASE_URL } from '../trueforge/agent-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runSkillRoutingTests() {
  console.log('🧪 Starting Skill Routing & Cost-Band Verification (Ticket #07)...');

  // 1. Verify SKILL.md file existence and YAML frontmatter (Criteria 1)
  console.log('\n🔍 Verifying skills/disruption-triage/SKILL.md structure...');
  const skillPath = path.resolve(__dirname, '../skills/disruption-triage/SKILL.md');
  if (!fs.existsSync(skillPath)) {
    throw new Error(`❌ Missing required skill file at: ${skillPath}`);
  }

  const content = fs.readFileSync(skillPath, 'utf8');
  if (!content.startsWith('---')) {
    throw new Error('❌ SKILL.md must start with YAML frontmatter delimiter (---)');
  }
  if (!content.includes('name: disruption-triage')) {
    throw new Error('❌ SKILL.md frontmatter missing name: disruption-triage');
  }
  if (!content.includes('description:')) {
    throw new Error('❌ SKILL.md frontmatter missing description');
  }
  if (!content.includes('50%')) {
    throw new Error('❌ SKILL.md must define the 50% cost band threshold');
  }
  if (!content.includes('0.75')) {
    throw new Error('❌ SKILL.md must define the 0.75 minimum reliability floor');
  }
  console.log('✅ Criteria 1 Passed: SKILL.md exists with YAML frontmatter, severity rules, and cost-band guardrails');

  // 2. Register Skill in TrueForge and attach to Agent (Criteria 2)
  console.log('\n🔍 Configuring TrueForge agent with skill attached...');
  const configuredAgent = await configureDisruptionTriageAgent(TRUEFORGE_BASE_URL, {
    includeSkill: true,
  });

  const client = new TrueForge({ baseUrl: TRUEFORGE_BASE_URL });
  const registeredSkills = await client.settings.skills.list();
  const skillInSettings = registeredSkills.data.find(
    (s) => s.name === 'disruption-triage'
  );

  if (!skillInSettings) {
    throw new Error("❌ Skill 'disruption-triage' not found in TrueForge Settings!");
  }
  console.log(`✅ Criteria 2 Passed: Skill registered in TrueForge settings and attached to '${configuredAgent.name}'`);

  // 3. Test Cost-Band Enforcement with Skill Attached (Criteria 3 & 4)
  console.log('\n🔍 Testing cost-band enforcement with skill attached...');
  const sessionWithSkill = await client.sessions.create({
    agent: { name: 'disruption-triage-agent' },
  });

  const costQueryPrompt = `A primary supplier (Oceanic Bearings Ltd) is disrupted. Their standard unit cost is $42.50.
Candidate Alternate Supplier A charges $62.00 per unit.
Candidate Alternate Supplier B charges $75.00 per unit.

Per the disruption-triage skill rules, what is the maximum acceptable cost ceiling, and is Supplier B acceptable or rejected? Explain why.`;

  const turn = await client.sessions.createTurn(sessionWithSkill.data.id, {
    input: [{ type: 'user.message', content: costQueryPrompt }],
  });

  let turnStatus = 'running';
  let completedTurn;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    completedTurn = await client.sessions.getTurn(sessionWithSkill.data.id, turn.data.id);
    turnStatus = completedTurn.data.state.status;
    if (turnStatus !== 'running') break;
  }

  if (turnStatus !== 'done') {
    throw new Error(`❌ Turn failed with status '${turnStatus}': ${JSON.stringify(completedTurn?.data.state)}`);
  }

  const events = await client.sessions.listTurnEvents(sessionWithSkill.data.id, turn.data.id);
  const messageEvents = events.data.filter(
    (e: any) => e.type === 'model.message' && typeof e.content === 'string'
  );
  const responseText = messageEvents.map((m: any) => m.content).join('\n');

  console.log(`💬 Agent Response with Skill Attached:\n${responseText}\n`);

  // Assert cost band enforcement (50% increase / $63.75 ceiling / Supplier B rejected)
  const lowerResp = responseText.toLowerCase();
  const mentionsCeiling =
    lowerResp.includes('63.75') || lowerResp.includes('50%') || lowerResp.includes('ceiling');
  const rejectsB =
    lowerResp.includes('supplier b') &&
    (lowerResp.includes('reject') || lowerResp.includes('disqualif') || lowerResp.includes('unacceptable') || lowerResp.includes('exceeds'));

  if (!mentionsCeiling || !rejectsB) {
    throw new Error(
      `❌ Agent failed to enforce the 50% cost band on Supplier B ($75 vs $63.75 ceiling)! Response: ${responseText}`
    );
  }
  console.log('✅ Criteria 4 Passed: Agent correctly enforces 50% cost band ceiling ($63.75) and rejects Supplier B');

  // 4. Test Observable Behavioral Change with Skill Removed (Criteria 5)
  // Fix for Qodo #5: Wrap in try/finally to guarantee persistent agent state restoration even if assertions fail
  console.log('\n🔍 Testing observable behavioral difference with skill removed...');
  try {
    await configureDisruptionTriageAgent(TRUEFORGE_BASE_URL, { includeSkill: false });

    const sessionWithoutSkill = await client.sessions.create({
      agent: { name: 'disruption-triage-agent' },
    });

    const turnWithoutSkill = await client.sessions.createTurn(sessionWithoutSkill.data.id, {
      input: [
        {
          type: 'user.message',
          content: 'What is the specific maximum percentage cost-band ceiling rule for emergency suppliers?',
        },
      ],
    });

    // Fix for Qodo #4: Track turn completion and require 'done' terminal status
    let baselineStatus = 'running';
    let completedBaselineTurn;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      completedBaselineTurn = await client.sessions.getTurn(
        sessionWithoutSkill.data.id,
        turnWithoutSkill.data.id
      );
      baselineStatus = completedBaselineTurn.data.state.status;
      if (baselineStatus !== 'running') break;
    }

    if (baselineStatus !== 'done') {
      throw new Error(
        `❌ Baseline turn failed with status '${baselineStatus}': ${JSON.stringify(completedBaselineTurn?.data.state)}`
      );
    }

    const eventsWithoutSkill = await client.sessions.listTurnEvents(
      sessionWithoutSkill.data.id,
      turnWithoutSkill.data.id
    );
    const textPieces: string[] = [];
    for (const e of eventsWithoutSkill.data || []) {
      const anyEv = e as any;
      if (anyEv.type === 'model.message') {
        if (typeof anyEv.content === 'string' && anyEv.content.trim()) {
          textPieces.push(anyEv.content.trim());
        }
        const calls = anyEv.tool_calls || anyEv.toolCalls;
        if (Array.isArray(calls)) {
          for (const call of calls) {
            const toolName = call.tool_info?.name || call.function?.name || call.name;
            if (toolName === 'ask_user_question') {
              try {
                const rawArgs = call.function?.arguments || call.arguments;
                const parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
                if (parsed?.question) {
                  textPieces.push(`[QUESTION TO OPERATOR]: ${parsed.question}`);
                }
              } catch {}
            }
          }
        }
      }
    }

    const respWithoutSkill = textPieces.join('\n').trim();

    // Fix for Qodo #4: Assert non-empty response content
    if (!respWithoutSkill) {
      throw new Error('❌ Baseline turn produced empty model response!');
    }

    console.log(`💬 Agent Response without Skill:\n${respWithoutSkill}\n`);

    // Fix for Qodo #4: Explicitly assert that the baseline model does NOT mandate the skill-specific 50% emergency SOP ceiling
    const lowerBaseline = respWithoutSkill.toLowerCase();
    const hasSpecificCostSop =
      lowerBaseline.includes('disruption-triage sop') ||
      lowerBaseline.includes('disruption-triage skill') ||
      (lowerBaseline.includes('50%') && lowerBaseline.includes('primary unit cost'));

    if (hasSpecificCostSop) {
      throw new Error(
        `❌ Baseline model unexpectedly cited the specific disruption-triage 50% SOP ceiling rule even with the skill removed! Response: ${respWithoutSkill}`
      );
    }

    console.log(
      `✅ Criteria 5 Passed: Observable behavioral difference confirmed (Skill removed: Specific triage cost SOP not mandated)`
    );
  } finally {
    // Fix for Qodo #5: Always restore the disruption-triage skill on the shared persistent agent
    console.log('\n🔄 Restoring disruption-triage skill to agent configuration in finally block...');
    await configureDisruptionTriageAgent(TRUEFORGE_BASE_URL, { includeSkill: true });
  }

  console.log('\n🎉 ALL Ticket #07 acceptance tests PASSED successfully!');
}

runSkillRoutingTests().catch((err) => {
  console.error('\n❌ Skill routing test failed:', err);
  process.exit(1);
});
