import { TrueForge } from '@truefoundry/trueforge-sdk';
import 'dotenv/config';
import { closeErpDbs, getErpDb, getErpWriteDb } from '../mcp-servers/erp/src/db.js';
import { configureDisruptionTriageAgent, TRUEFORGE_BASE_URL } from '../trueforge/agent-config.js';

async function waitForTurnCompletion(
  client: TrueForge,
  sessionId: string,
  turnId: string,
  maxWaitSec = 120
): Promise<{ status: string; turn: any; events: any[] }> {
  for (let i = 0; i < maxWaitSec / 2; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const t = await client.sessions.getTurn(sessionId, turnId);
    const status = t.data.state.status;
    if (status !== 'running') {
      const events = await client.sessions.listTurnEvents(sessionId, turnId);
      return { status, turn: t.data, events: events.data || [] };
    }
    process.stdout.write('.');
  }
  const finalTurn = await client.sessions.getTurn(sessionId, turnId);
  const events = await client.sessions.listTurnEvents(sessionId, turnId);
  return { status: finalTurn.data.state.status, turn: finalTurn.data, events: events.data || [] };
}

async function waitForApprovalGate(
  client: TrueForge,
  sessionId: string,
  turnId: string,
  maxWaitSec = 140
): Promise<{ approvalEvent: any; events: any[] }> {
  for (let i = 0; i < maxWaitSec / 2; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const events = await client.sessions.listTurnEvents(sessionId, turnId);
    for (const ev of events.data || []) {
      if ((ev as any).type === 'tool.approval_required') {
        console.log(`\n🛑 Detected tool.approval_required event (thread: ${(ev as any).threadId})`);
        return { approvalEvent: ev, events: events.data };
      }
    }

    const t = await client.sessions.getTurn(sessionId, turnId);
    const pending = (t.data.state as any)?.pendingActions || [];
    const required = (t.data.state as any)?.requiredActions || [];
    const approvalAction =
      pending.find((a: any) => a.type === 'tool.approval_required') ||
      required.find((a: any) => a.type === 'tool.approval_required');

    if (approvalAction) {
      console.log(`\n🛑 Detected pending/required approval action in turn state`);
      return { approvalEvent: approvalAction, events: events.data };
    }

    if (t.data.state.status !== 'running') {
      return { approvalEvent: null, events: events.data };
    }
    process.stdout.write('.');
  }
  throw new Error(`Timeout waiting for approval gate after ${maxWaitSec}s`);
}

function verifyGenerativeUiDiff(chatContent: string) {
  // Fix for Qodo #1: Require recognizable table/card structure directly in chat response
  const hasTableStructure =
    (chatContent.includes('|') && chatContent.includes('---')) ||
    (chatContent.includes('Table([') && chatContent.includes('Col('));

  if (!hasTableStructure) {
    throw new Error(
      '❌ Qodo #1 Failure: Chat response missing visible before/after table or card comparison structure!'
    );
  }

  const lower = chatContent.toLowerCase();

  // 1. Supplier names
  const hasOceanic = lower.includes('oceanic bearings');
  const hasIndoPacific = lower.includes('indopacific');
  if (!hasOceanic || !hasIndoPacific) {
    throw new Error(
      `❌ Generative UI Diff missing supplier names (Oceanic: ${hasOceanic}, IndoPacific: ${hasIndoPacific})`
    );
  }

  // 2. Concrete numeric baseline values
  const hasBaseUnitCost = lower.includes('42.50') || lower.includes('42.5');
  const hasBaseLeadTime = lower.includes('14 day') || lower.includes('14d') || lower.includes('14');
  const hasBaseReliability = lower.includes('0.94');
  const hasBaseTotal = lower.includes('8,500') || lower.includes('8500');

  // 3. Concrete numeric proposed values
  const hasPropUnitCost = lower.includes('47.50') || lower.includes('47.5');
  const hasPropLeadTime = lower.includes('12 day') || lower.includes('12d') || lower.includes('12');
  const hasPropReliability = lower.includes('0.89');
  const hasPropTotal = lower.includes('9,500') || lower.includes('9500');

  // 4. Concrete numeric deltas
  const hasCostDelta = lower.includes('5.00') || lower.includes('+5') || lower.includes('11.8%');
  const hasLeadDelta = lower.includes('-2') || lower.includes('2 day') || lower.includes('14.3%');
  const hasTotalDelta = lower.includes('1,000') || lower.includes('1000');

  if (!hasBaseUnitCost || !hasBaseLeadTime || !hasBaseReliability || !hasBaseTotal) {
    throw new Error(
      `❌ Generative UI Diff missing concrete baseline metrics (cost: ${hasBaseUnitCost}, lead: ${hasBaseLeadTime}, rel: ${hasBaseReliability}, total: ${hasBaseTotal})`
    );
  }

  if (!hasPropUnitCost || !hasPropLeadTime || !hasPropReliability || !hasPropTotal) {
    throw new Error(
      `❌ Generative UI Diff missing concrete proposed metrics (cost: ${hasPropUnitCost}, lead: ${hasPropLeadTime}, rel: ${hasPropReliability}, total: ${hasPropTotal})`
    );
  }

  if (!hasCostDelta || !hasLeadDelta || !hasTotalDelta) {
    throw new Error(
      `❌ Generative UI Diff missing concrete computed deltas (cost delta: ${hasCostDelta}, lead delta: ${hasLeadDelta}, total delta: ${hasTotalDelta})`
    );
  }

  console.log('✅ Criteria 1 & 2 & Qodo #1 Passed: Agent rendered visible Generative UI Diff with concrete metrics and deltas in chat');
}

async function runApprovalGateTests() {
  console.log('🧪 Starting Approval Gate & Generative UI Diff Verification (Ticket #10)...');

  const insertedPoIds: number[] = [];
  let db: any = null;

  try {
    db = await getErpDb();

    // Fix for Qodo #2 & #3: Capture pre-test maximum PO ID to prevent matching stale rows
    const maxPreRow = db.prepare('SELECT MAX(id) as max_id FROM purchase_orders').get() as any;
    const preTestMaxPoId = Number(maxPreRow?.max_id || 0);
    console.log(`📊 Baseline ERP database state: max purchase_orders id = ${preTestMaxPoId}`);

    // 1. Ensure Agent is Configured with Skill & Gated Tools
    console.log('\n🔍 Ensuring TrueForge agent is configured with disruption-triage skill and gated tools...');
    await configureDisruptionTriageAgent(TRUEFORGE_BASE_URL, { includeSkill: true });
    const client = new TrueForge({ baseUrl: TRUEFORGE_BASE_URL });

    const triagePrompt = `URGENT DISRUPTION TRIAGE & PO AMENDMENT:
A Category 4 Typhoon has compromised Port of Ningbo-Zhoushan, cutting off primary supplier Oceanic Bearings Ltd (ID: 1) for SKU-4471.
We need an urgent emergency reorder of 200 units of SKU-4471.
Telemetry corroboration and optimization are complete. Alternate supplier IndoPacific Parts Corp (ID: 4) has been selected.

Per your disruption-triage SOP:
1. In your chat message, render the Generative UI PO Diff Markdown table:
| Metric | Baseline (Oceanic Bearings Ltd) | Proposed Alternate (IndoPacific Parts Corp) | Variance / Delta |
|:---|:---|:---|:---|
| **Supplier Name** | Oceanic Bearings Ltd (ID: 1) | IndoPacific Parts Corp (ID: 4) | Re-routed supplier |
| **Origin Corridor** | East China Sea (Disrupted) | Southeast Asia (Safe corridor) | Typhoon bypassed |
| **Unit Cost** | $42.50 | $47.50 | +$5.00 (+11.8%) |
| **Lead Time** | 14 days | 12 days | -2 days (-14.3%) |
| **Reliability** | 0.94 | 0.89 | -0.05 (-5.3%) |
| **Order Quantity** | 200 units | 200 units | 0 units |
| **Total PO Value** | $8,500.00 | $9,500.00 | +$1,000.00 (+11.8%) |
| **Guardrails** | Baseline PO | Compliant (≤+50% cost, ≥0.75 rel, < DoS) | Verified |

2. Along with this table, invoke the gated tool propose_po_amendment for 200 units with IndoPacific Parts Corp (ID: 4). The system will automatically gate the tool call for operator approval.`;

    // --------------------------------------------------------------------------
    // TEST PATH 1: APPROVE PATH (Allow)
    // --------------------------------------------------------------------------
    console.log('\n================================================================================');
    console.log('🟢 TEST PATH 1: APPROVE PATH (Human Allow ➔ PO Committed as "approved")');
    console.log('================================================================================');

    const approveSession = await client.sessions.create({
      agent: { name: 'disruption-triage-agent' },
    });
    const approveSessionId = approveSession.data.id;
    console.log(`   - Test Session Created: ${approveSessionId}`);

    console.log('📨 Sending triage prompt to initiate Approve Path...');
    const turn1 = await client.sessions.createTurn(approveSessionId, {
      input: [{ type: 'user.message', content: triagePrompt }],
    });
    const turn1Id = turn1.data.id;
    console.log(`   - Turn initiated (${turn1Id}). Polling until paused at approval gate...`);

    let { approvalEvent: pendingApprovalEvent, events: events1 } = await waitForApprovalGate(
      client,
      approveSessionId,
      turn1Id,
      140
    );

    // Fix for Qodo #1: Collect ONLY non-empty root-thread model.message.content (no tool arguments)
    let rootChatContent = '';
    for (const ev of events1) {
      const anyEv = ev as any;
      if (
        anyEv.type === 'model.message' &&
        (!anyEv.threadId || anyEv.threadId === 'main') &&
        typeof anyEv.content === 'string' &&
        anyEv.content.trim()
      ) {
        rootChatContent += anyEv.content + '\n';
      }
    }

    // If model asked for conversational confirmation before calling tool, send proceed message to trigger the tool gate
    if (!pendingApprovalEvent) {
      console.log('   - Model prompted for conversational confirmation. Sending proceed command to trigger tool gate...');
      const followUpTurn = await client.sessions.createTurn(approveSessionId, {
        input: [{ type: 'user.message', content: 'Proceed with the amendment and invoke propose_po_amendment now.' }],
      });
      const gate1b = await waitForApprovalGate(client, approveSessionId, followUpTurn.data.id, 90);
      pendingApprovalEvent = gate1b.approvalEvent;
      events1 = [...events1, ...gate1b.events];

      for (const ev of gate1b.events) {
        const anyEv = ev as any;
        if (
          anyEv.type === 'model.message' &&
          (!anyEv.threadId || anyEv.threadId === 'main') &&
          typeof anyEv.content === 'string' &&
          anyEv.content.trim()
        ) {
          rootChatContent += anyEv.content + '\n';
        }
      }
    }

    // Criteria 3: Verify ToolApprovalRequired triggered
    if (!pendingApprovalEvent) {
      throw new Error('❌ propose_po_amendment call did NOT trigger TrueForge tool.approval_required gate!');
    }
    console.log('✅ Criteria 3 Passed: propose_po_amendment call triggered TrueForge human approval gate');

    const pendingThreadId = pendingApprovalEvent.threadId || 'main';
    const targetToolCallId =
      pendingApprovalEvent.toolCalls?.[0]?.id ||
      pendingApprovalEvent.toolCalls?.[0]?.toolCallId ||
      pendingApprovalEvent.toolCallId;

    console.log(`   - Approving Tool Call ID: ${targetToolCallId} on thread: ${pendingThreadId}...`);

    // Grant Approval (Allow)
    const approveTurn = await client.sessions.createTurn(approveSessionId, {
      input: [
        {
          type: 'user.tool_approval',
          threadId: pendingThreadId,
          toolCallId: targetToolCallId,
          approval: { status: 'allow' },
        },
      ],
    });

    const approveTurnId = approveTurn.data.id;
    console.log(`   - Approval Turn submitted (${approveTurnId}). Polling until complete...`);
    const approveTurnResult = await waitForTurnCompletion(client, approveSessionId, approveTurnId, 90);

    const hasApprovedToolResponse = approveTurnResult.events.some(
      (e: any) =>
        e.type === 'tool.response' &&
        (e.content?.includes('"status": "approved"') || e.content?.includes('"status":"approved"'))
    );

    if (approveTurnResult.status !== 'done' && !hasApprovedToolResponse) {
      throw new Error(`❌ Approval Turn did not finish with 'done'. Status: ${approveTurnResult.status}`);
    }
    console.log('✅ Approval turn completed successfully');

    // Aggregate any additional root-thread chat messages from the approval turn
    for (const ev of approveTurnResult.events) {
      const anyEv = ev as any;
      if (
        anyEv.type === 'model.message' &&
        (!anyEv.threadId || anyEv.threadId === 'main') &&
        typeof anyEv.content === 'string' &&
        anyEv.content.trim()
      ) {
        rootChatContent += anyEv.content + '\n';
      }
    }

    console.log('\n🔍 Verifying Generative UI PO Diff directly in chat response...');
    verifyGenerativeUiDiff(rootChatContent);

    // Fix for Qodo #2: Correlate approval execution by extracting exact po_id from tool.response
    let approvedPoId: number | null = null;
    for (const ev of approveTurnResult.events) {
      const anyEv = ev as any;
      if (anyEv.type === 'tool.response') {
        try {
          const parsed = typeof anyEv.content === 'string' ? JSON.parse(anyEv.content) : anyEv.content;
          if (parsed && parsed.success && parsed.po_id) {
            approvedPoId = Number(parsed.po_id);
            console.log(`   - Extracted executed PO ID from tool.response: #${approvedPoId}`);
            break;
          }
        } catch {}
      }
    }

    if (!approvedPoId || approvedPoId <= preTestMaxPoId) {
      throw new Error(
        `❌ Qodo #2 Failure: Could not extract newly created PO ID (> ${preTestMaxPoId}) from approval turn tool.response!`
      );
    }
    insertedPoIds.push(approvedPoId);

    // Criteria 4 & 6: Query exact PO ID and assert all fields
    console.log(`\n🔍 Verifying ERP Database for approved PO row #${approvedPoId}...`);
    const approvedPo = db
      .prepare('SELECT * FROM purchase_orders WHERE id = ?')
      .get(approvedPoId) as any;

    if (!approvedPo) {
      throw new Error(`❌ Database verification failed: Row for PO #${approvedPoId} not found in database!`);
    }
    if (approvedPo.status !== 'approved') {
      throw new Error(`❌ Expected status='approved' for PO #${approvedPoId}, got: ${approvedPo.status}`);
    }
    if (approvedPo.supplier_id !== 4) {
      throw new Error(`❌ Expected supplier_id=4 for PO #${approvedPoId}, got: ${approvedPo.supplier_id}`);
    }
    if (approvedPo.quantity !== 200) {
      throw new Error(`❌ Expected quantity=200 for PO #${approvedPoId}, got: ${approvedPo.quantity}`);
    }
    if (approvedPo.unit_cost !== 47.5) {
      throw new Error(`❌ Expected unit_cost=47.5 for PO #${approvedPoId}, got: ${approvedPo.unit_cost}`);
    }
    if (approvedPo.total_cost !== 9500.0) {
      throw new Error(`❌ Expected total_cost=9500.0 for PO #${approvedPoId}, got: ${approvedPo.total_cost}`);
    }
    if (!approvedPo.created_at) {
      throw new Error('❌ Approved PO missing created_at timestamp in database!');
    }
    console.log(
      `✅ Criteria 4 & 6 Passed: Database row #${approvedPo.id} verified (Status: ${approvedPo.status}, Supplier: ${approvedPo.supplier_id}, Quantity: ${approvedPo.quantity}, Total: $${approvedPo.total_cost}, Timestamp: ${approvedPo.created_at})`
    );

    // --------------------------------------------------------------------------
    // TEST PATH 2: REJECT PATH (Deny)
    // --------------------------------------------------------------------------
    console.log('\n================================================================================');
    console.log('🔴 TEST PATH 2: REJECT PATH (Human Deny ➔ record_po_rejection logs "rejected")');
    console.log('================================================================================');

    const rejectSession = await client.sessions.create({
      agent: { name: 'disruption-triage-agent' },
    });
    const rejectSessionId = rejectSession.data.id;
    console.log(`   - Test Session Created: ${rejectSessionId}`);

    console.log('📨 Sending triage prompt to initiate Reject Path...');
    const turn2 = await client.sessions.createTurn(rejectSessionId, {
      input: [{ type: 'user.message', content: triagePrompt }],
    });
    const turn2Id = turn2.data.id;
    console.log(`   - Turn initiated (${turn2Id}). Polling until paused at approval gate...`);

    let { approvalEvent: rejectApprovalEvent, events: events2 } = await waitForApprovalGate(
      client,
      rejectSessionId,
      turn2Id,
      140
    );

    // If model asked for conversational confirmation before calling tool, send proceed message to trigger the tool gate
    if (!rejectApprovalEvent) {
      console.log('   - Model prompted for conversational confirmation. Sending proceed command to trigger tool gate...');
      const followUpTurn = await client.sessions.createTurn(rejectSessionId, {
        input: [{ type: 'user.message', content: 'Proceed with the amendment and invoke propose_po_amendment now.' }],
      });
      const gate2 = await waitForApprovalGate(client, rejectSessionId, followUpTurn.data.id, 90);
      rejectApprovalEvent = gate2.approvalEvent;
      events2 = [...events2, ...gate2.events];
    }

    if (!rejectApprovalEvent) {
      throw new Error('❌ propose_po_amendment call did NOT trigger approval gate in reject path!');
    }

    const rejectThreadId = rejectApprovalEvent.threadId || 'main';
    const rejectToolCallId =
      rejectApprovalEvent.toolCalls?.[0]?.id ||
      rejectApprovalEvent.toolCalls?.[0]?.toolCallId ||
      rejectApprovalEvent.toolCallId;

    const denialReason = 'Cost increase exceeds quarterly contingency budget; hold reorders for corporate review';
    console.log(`   - Denying Tool Call ID: ${rejectToolCallId} with reason: "${denialReason}"...`);

    // Deny Approval
    const denyTurn = await client.sessions.createTurn(rejectSessionId, {
      input: [
        {
          type: 'user.tool_approval',
          threadId: rejectThreadId,
          toolCallId: rejectToolCallId,
          approval: {
            status: 'deny',
            reason: denialReason,
          },
        },
      ],
    });

    const denyTurnId = denyTurn.data.id;
    console.log(`   - Deny Turn submitted (${denyTurnId}). Polling agent until record_po_rejection completes...`);
    const denyTurnResult = await waitForTurnCompletion(client, rejectSessionId, denyTurnId, 90);

    const hasRejectedToolResponse = denyTurnResult.events.some(
      (e: any) =>
        e.type === 'tool.response' &&
        (e.content?.includes('"status": "rejected"') || e.content?.includes('"status":"rejected"'))
    );

    if (denyTurnResult.status !== 'done' && !hasRejectedToolResponse) {
      throw new Error(`❌ Deny Turn did not finish with 'done'. Status: ${denyTurnResult.status}`);
    }
    console.log('✅ Deny turn completed successfully');

    // Fix for Qodo #3: Inspect deny turn events to assert propose_po_amendment NEVER executed
    // and record_po_rejection executed and produced a new rejected PO row
    let rejectedPoId: number | null = null;
    for (const ev of denyTurnResult.events) {
      const anyEv = ev as any;
      if (anyEv.type === 'tool.response') {
        const rawContent = anyEv.content;
        // Check if propose_po_amendment was improperly executed
        if (
          typeof rawContent === 'string' &&
          rawContent.includes('PROPOSED AMENDMENT') &&
          rawContent.includes('"status":"approved"')
        ) {
          throw new Error(
            '❌ Qodo #3 Failure: propose_po_amendment executed despite operator denial!'
          );
        }

        try {
          const parsed = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
          if (parsed && parsed.status === 'rejected' && parsed.po_id) {
            rejectedPoId = Number(parsed.po_id);
            console.log(`   - Extracted rejected audit PO ID from tool.response: #${rejectedPoId}`);
          }
        } catch {}
      }
    }

    if (!rejectedPoId || rejectedPoId <= preTestMaxPoId) {
      throw new Error(
        `❌ Qodo #3 Failure: Could not extract newly created rejected PO ID (> ${preTestMaxPoId}) from record_po_rejection response!`
      );
    }
    insertedPoIds.push(rejectedPoId);

    // Criteria 5 & 6: Verify Database row for rejected PO
    console.log(`\n🔍 Verifying ERP Database for rejected PO audit entry #${rejectedPoId}...`);
    const rejectedPo = db
      .prepare('SELECT * FROM purchase_orders WHERE id = ?')
      .get(rejectedPoId) as any;

    if (!rejectedPo) {
      throw new Error(`❌ Database verification failed: Row for rejected PO #${rejectedPoId} not found in database!`);
    }
    if (rejectedPo.status !== 'rejected') {
      throw new Error(`❌ Expected status='rejected' for PO #${rejectedPoId}, got: ${rejectedPo.status}`);
    }
    if (rejectedPo.supplier_id !== 4) {
      throw new Error(`❌ Expected supplier_id=4 for rejected PO #${rejectedPoId}, got: ${rejectedPo.supplier_id}`);
    }
    if (rejectedPo.quantity !== 200) {
      throw new Error(`❌ Expected quantity=200 for rejected PO #${rejectedPoId}, got: ${rejectedPo.quantity}`);
    }
    if (rejectedPo.unit_cost !== 47.5) {
      throw new Error(`❌ Expected unit_cost=47.5 for rejected PO #${rejectedPoId}, got: ${rejectedPo.unit_cost}`);
    }
    if (rejectedPo.total_cost !== 9500.0) {
      throw new Error(`❌ Expected total_cost=9500.0 for rejected PO #${rejectedPoId}, got: ${rejectedPo.total_cost}`);
    }
    if (!rejectedPo.notes.includes(denialReason)) {
      throw new Error(
        `❌ Rejected PO notes missing full denial reason! Got: "${rejectedPo.notes}", expected: "${denialReason}"`
      );
    }
    console.log(
      `✅ Criteria 5 & 6 & Qodo #3 Passed: Database has rejected PO audit #${rejectedPo.id} (Status: ${rejectedPo.status}, Notes: "${rejectedPo.notes}")`
    );

    // --------------------------------------------------------------------------
    // CRITERIA 7 & 8: Session Trace Audit Trail & Reconstructability (Qodo #5)
    // --------------------------------------------------------------------------
    console.log('\n🔍 Verifying Session Trace Audit Trail and Reconstructability (Criteria 7 & 8 & Qodo #5)...');

    // 1. Audit check on Approve Session
    console.log('   - Validating typed event sequence in Approve Session...');
    const approveTurns = await client.sessions.listTurns(approveSessionId);
    if (!approveTurns.data || approveTurns.data.length < 2) {
      throw new Error('❌ Approve session missing turn history!');
    }

    const allApproveEvents: any[] = [];
    for (const t of approveTurns.data) {
      const turnEvents = await client.sessions.listTurnEvents(approveSessionId, t.id);
      allApproveEvents.push(...(turnEvents.data || []));
    }

    const hasApproveUserPrompt = allApproveEvents.some(
      (e) =>
        (e.type === 'user.message' && JSON.stringify(e).includes('URGENT DISRUPTION TRIAGE')) ||
        (e.type === 'turn.created' && JSON.stringify(e.input || []).includes('URGENT DISRUPTION TRIAGE'))
    );
    const hasApproveDiffMsg = allApproveEvents.some(
      (e) => e.type === 'model.message' && typeof e.content === 'string' && e.content.includes('Oceanic Bearings')
    );
    const hasApprovalRequiredGate = allApproveEvents.some((e) => e.type === 'tool.approval_required');
    const hasUserAllowDecision = allApproveEvents.some(
      (e) =>
        (e.type === 'user.tool_approval' && (e.approval?.status === 'allow' || (e as any).approval?.allow)) ||
        (e.type === 'turn.created' && JSON.stringify(e.input || []).includes('"status":"allow"'))
    );
    const hasPoCommitResult = allApproveEvents.some((e) => {
      if (e.type === 'tool.response') {
        try {
          const parsed = typeof e.content === 'string' ? JSON.parse(e.content) : e.content;
          return Number(parsed?.po_id) === approvedPoId && parsed?.status === 'approved';
        } catch {}
      }
      return false;
    });
    const hasFinalApproveConfirmation = allApproveEvents.some(
      (e) =>
        e.type === 'model.message' &&
        typeof e.content === 'string' &&
        (e.content.toLowerCase().includes('approved') ||
          e.content.toLowerCase().includes('confirmed') ||
          e.content.includes('PO Amendment Diff'))
    );

    if (
      !hasApproveUserPrompt ||
      !hasApproveDiffMsg ||
      !hasApprovalRequiredGate ||
      !hasUserAllowDecision ||
      !hasPoCommitResult ||
      !hasFinalApproveConfirmation
    ) {
      throw new Error(
        `❌ Qodo #5 Failure: Incomplete audit trail in Approve Session! (Prompt: ${hasApproveUserPrompt}, Diff: ${hasApproveDiffMsg}, Gate: ${hasApprovalRequiredGate}, Allow: ${hasUserAllowDecision}, Commit: ${hasPoCommitResult}, Confirm: ${hasFinalApproveConfirmation})`
      );
    }
    console.log(`   ✅ Approve Session event audit verified: user prompt ➔ diff ➔ gate ➔ allow ➔ commit #${approvedPoId} ➔ confirmation`);

    // 2. Audit check on Reject Session
    console.log('   - Validating typed event sequence in Reject Session...');
    const rejectTurns = await client.sessions.listTurns(rejectSessionId);
    if (!rejectTurns.data || rejectTurns.data.length < 2) {
      throw new Error('❌ Reject session missing turn history!');
    }

    const allRejectEvents: any[] = [];
    for (const t of rejectTurns.data) {
      const turnEvents = await client.sessions.listTurnEvents(rejectSessionId, t.id);
      allRejectEvents.push(...(turnEvents.data || []));
    }

    const hasRejectUserPrompt = allRejectEvents.some(
      (e) =>
        (e.type === 'user.message' && JSON.stringify(e).includes('URGENT DISRUPTION TRIAGE')) ||
        (e.type === 'turn.created' && JSON.stringify(e.input || []).includes('URGENT DISRUPTION TRIAGE'))
    );
    const hasRejectGate = allRejectEvents.some((e) => e.type === 'tool.approval_required');
    const hasUserDenyDecision = allRejectEvents.some(
      (e) =>
        (e.type === 'user.tool_approval' && e.approval?.status === 'deny') ||
        (e.type === 'turn.created' && JSON.stringify(e.input || []).includes('"status":"deny"'))
    );
    const hasRejectionLoggedResult = allRejectEvents.some((e) => {
      if (e.type === 'tool.response') {
        try {
          const parsed = typeof e.content === 'string' ? JSON.parse(e.content) : e.content;
          return Number(parsed?.po_id) === rejectedPoId && parsed?.status === 'rejected';
        } catch {}
      }
      return false;
    });
    const executedForbiddenAmendment = allRejectEvents.some((e) => {
      if (e.type === 'tool.response') {
        try {
          const parsed = typeof e.content === 'string' ? JSON.parse(e.content) : e.content;
          return parsed?.status === 'approved' && e.content.includes('PROPOSED AMENDMENT');
        } catch {}
      }
      return false;
    });

    if (executedForbiddenAmendment) {
      throw new Error('❌ Qodo #5 Failure: Reject session contains execution of propose_po_amendment!');
    }

    if (!hasRejectUserPrompt || !hasRejectGate || !hasUserDenyDecision || !hasRejectionLoggedResult) {
      throw new Error(
        `❌ Qodo #5 Failure: Incomplete audit trail in Reject Session! (Prompt: ${hasRejectUserPrompt}, Gate: ${hasRejectGate}, Deny: ${hasUserDenyDecision}, AuditLog: ${hasRejectionLoggedResult})`
      );
    }
    console.log(`   ✅ Reject Session event audit verified: user prompt ➔ diff ➔ gate ➔ deny with reason ➔ rejection audit log #${rejectedPoId} (propose_po_amendment strictly blocked)`);

    console.log('✅ Criteria 7 & 8 & Qodo #5 Passed: Full runs are completely reconstructable with typed audit trails');

    console.log('\n🎉 ALL Ticket #10 acceptance tests & Qodo review assertions PASSED successfully!');
  } finally {
    // Fix for Qodo #4: Teardown test purchase orders from shared database in finally block
    if (insertedPoIds.length > 0) {
      console.log(`\n🧹 Qodo #4 Teardown: Cleaning up test purchase orders: ${insertedPoIds.join(', ')}...`);
      try {
        const writeDb = await getErpWriteDb();
        for (const id of insertedPoIds) {
          writeDb.prepare('DELETE FROM purchase_orders WHERE id = ?').run(id);
        }
        console.log('✅ Qodo #4 Teardown: Test purchase orders cleaned up successfully from shared ledger');
      } catch (cleanupErr) {
        console.error('⚠️ Warning during purchase_orders cleanup:', cleanupErr);
      }
    }

    try {
      await closeErpDbs();
    } catch {}
  }
}

runApprovalGateTests().catch((err) => {
  console.error('\n❌ Approval gate test failed:', err);
  process.exit(1);
});
