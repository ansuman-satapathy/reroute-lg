import { TrueForge } from '@truefoundry/trueforge-sdk';
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TRUEFORGE_BASE_URL =
  process.env.TRUEFORGE_URL || process.env.TRUEFORGE_BASE_URL || 'http://localhost:8790';

import { extractToolName } from './inject-alert.js';

interface StepTiming {
  name: string;
  timestampMs: number;
  deltaFromStartSec: number;
  durationFromPrevSec: number;
}

export async function measureTriageExecutionTiming(): Promise<StepTiming[]> {
  console.log('⏱️ Starting End-to-End Triage Timing Benchmark (Pre-Submission Audit #9)...');
  console.log(`🔌 Connecting to TrueForge instance at: ${TRUEFORGE_BASE_URL}`);
  const client = new TrueForge({ baseUrl: TRUEFORGE_BASE_URL });

  // Load primary alert fixture
  const fixturePath = path.resolve(__dirname, '../fixtures/disruption-alert.json');
  const alert = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  const alertPrompt = `[INCOMING AUTOMATED WEBHOOK ALERT - ${alert.event_id}]
A HIGH-SEVERITY disruption alert has just been received for your monitored corridor:

${JSON.stringify(alert, null, 2)}

INSTRUCTIONS:
Execute your standard disruption triage protocol immediately:
1. First, corroborate the incoming disruption signal via live telemetry.
2. Inspect inventory buffer vulnerability for affected parts using read_inventory.
3. Identify the primary supplier and discover qualified alternate suppliers using read_suppliers.
4. Run multi-criteria cost optimization in TrueForge's sandbox via exec.
5. Render a Generative UI PO Diff table in chat and invoke propose_po_amendment for the top-ranked compliant alternate.`;

  const timings: StepTiming[] = [];
  const startMs = Date.now();

  function recordStep(name: string) {
    const nowMs = Date.now();
    const prevMs = timings.length > 0 ? timings[timings.length - 1].timestampMs : startMs;
    const timing: StepTiming = {
      name,
      timestampMs: nowMs,
      deltaFromStartSec: Number(((nowMs - startMs) / 1000).toFixed(2)),
      durationFromPrevSec: Number(((nowMs - prevMs) / 1000).toFixed(2)),
    };
    timings.push(timing);
    console.log(`   ⏱️ [${timing.deltaFromStartSec}s (+${timing.durationFromPrevSec}s)] ${name}`);
  }

  recordStep('Benchmark Initiated');

  // Create session
  const session = await client.sessions.create({
    agent: { name: 'disruption-triage-agent' },
  });
  const sessionId = session.data.id;
  recordStep(`Session Created (${sessionId})`);

  // Dispatch turn
  const turn = await client.sessions.createTurn(sessionId, {
    input: [{ type: 'user.message', content: alertPrompt }],
  });
  const turnId = turn.data.id;
  recordStep(`Turn Dispatched (${turnId})`);

  const observedTools = new Set<string>();
  let reachedGate = false;
  let lastTurnState: any = null;
  const maxPollAttempts = 60;
  let completedInPoll = false;

  for (let poll = 0; poll < maxPollAttempts; poll++) {
    await new Promise((r) => setTimeout(r, 2000));

    const events = await client.sessions.listTurnEvents(sessionId, turnId);
    for (const ev of events.data || []) {
      const anyEv = ev as any;
      const calls = anyEv.tool_calls || anyEv.toolCalls || [];
      for (const call of calls) {
        // Fix for Qodo #6: Use canonical extractToolName including wrapper unwrapping
        const toolName = extractToolName(call);
        if (toolName && !observedTools.has(toolName)) {
          observedTools.add(toolName);
          recordStep(`Tool Invoked: ${toolName}`);
        }
      }

      if (anyEv.type === 'tool.approval_required' && !reachedGate) {
        reachedGate = true;
        recordStep('Human Approval Gate Triggered (tool.approval_required)');
      }
    }

    const t = await client.sessions.getTurn(sessionId, turnId);
    lastTurnState = t.data.state;
    const pending = (t.data.state as any)?.pendingActions || [];
    const required = (t.data.state as any)?.requiredActions || [];
    const approvalAction =
      pending.find((a: any) => a.type === 'tool.approval_required') ||
      required.find((a: any) => a.type === 'tool.approval_required');

    if (approvalAction && !reachedGate) {
      reachedGate = true;
      recordStep('Human Approval Gate Triggered (state.requiredActions)');
    }

    if (reachedGate) {
      completedInPoll = true;
      break;
    }

    // Fix for Qodo #3: Explicitly fail on error or cancellation
    if (t.data.state.status === 'error') {
      throw new Error(`❌ Turn failed with error state: ${JSON.stringify(t.data.state)}`);
    }
    if (t.data.state.status === 'cancelled') {
      throw new Error(`❌ Turn was cancelled prematurely before reaching approval gate.`);
    }

    if (t.data.state.status !== 'running') {
      completedInPoll = true;
      break;
    }
  }

  if (!completedInPoll && !reachedGate) {
    throw new Error(`❌ Benchmark timed out after ${maxPollAttempts * 2}s polling without reaching approval gate.`);
  }

  // Fix for Qodo #3: Fail benchmark if turn completed without triggering approval gate
  if (!reachedGate) {
    throw new Error(
      `❌ Benchmark failed: Turn finished with status '${lastTurnState?.status}' without triggering the human approval gate (propose_po_amendment)!`
    );
  }

  recordStep('Human Approval Gate Verified & Paused');

  console.log('\n================================================================================');
  console.log('📊 END-TO-END DEMO TIMING BENCHMARK REPORT');
  console.log('================================================================================');
  console.log('| Milestone | Elapsed Time (Total) | Duration (Step) | Status |');
  console.log('|:---|:---:|:---:|:---:|');
  for (const t of timings) {
    console.log(`| ${t.name} | ${t.deltaFromStartSec}s | +${t.durationFromPrevSec}s | ✓ |`);
  }

  const totalTimeSec = timings[timings.length - 1].deltaFromStartSec;
  console.log('--------------------------------------------------------------------------------');
  console.log(`🎯 Total Wall-Clock Time to Approval Gate: ${totalTimeSec} seconds`);

  if (totalTimeSec <= 90) {
    console.log(`✅ Passed: Pipeline reaches approval gate in ${totalTimeSec}s, easily fitting a 3-minute video demo!`);
  } else {
    console.log(`⚠️ Advisory: Pipeline took ${totalTimeSec}s. Consider fast-forwarding tool execution in video editing.`);
  }

  return timings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  measureTriageExecutionTiming()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Timing benchmark failed:', err);
      process.exit(1);
    });
}
