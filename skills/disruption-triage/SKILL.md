---
name: disruption-triage
description: Standard operating procedure and decision rules for logistics disruption triage, supplier re-routing, severity escalation, and purchase order amendment approval gates.
---

# Logistics Disruption Triage & Supplier Re-Routing SOP

This skill defines the autonomous evaluation protocol and operational guardrails for the Supply-Chain Disruption Triage Specialist agent.

---

## 1. Severity-Based Routing Rules

When an incoming disruption signal (weather event, port closure, news alert) is detected:

| Alert Severity | Operational Response Protocol |
| :--- | :--- |
| **HIGH** | **Immediate Autonomous Triage Trigger**: Do NOT wait for human prompting. Automatically execute the full evaluation sequence: query affected inventory, assess supplier vulnerability, discover alternates, run cost optimization, and prepare a gated PO amendment. |
| **MEDIUM** | **Deferred Assessment**: Query inventory buffer and monitor corridor telemetry. Present vulnerability findings to the human operator, but defer alternate supplier re-routing until human confirms or condition escalates to HIGH. |
| **LOW** | **Informational Logging**: Log the telemetry notice in audit records. Maintain normal operations schedule; no inventory or supplier actions required. |

---

## 2. Structured Evaluation Sequence

When triggered by a **HIGH** severity event, execute these phases in exact order:

```
[Incoming High Alert]
         │
         ▼
[Step 1: Inventory Buffer Analysis]
   - Query `read_inventory` for affected SKU(s) (returns `current_stock`, `reorder_threshold`, `daily_burn_rate`, and `days_of_supply`)
   - Confirm Days of Supply (DoS = `current_stock / daily_burn_rate`). For SKU-4471: 140 / 10 = 14 days.
   - Calculate projected stockout date (`now() + DoS days`)
         │
         ▼
[Step 2: Alternate Supplier Discovery & Parallel Carrier Queries]
   - Query `read_suppliers` for candidate suppliers offering the SKU outside the disrupted corridor
   - When carrier transit times, rates, and space allocations must be evaluated:
     * Delegate carrier capacity queries to TrueForge's native `create_sub_agent` tool
     * Spawn parallel subagents — one per carrier (`maersk-pacific`, `evergreen-express`, `cma-cgm-asia`)
     * Each subagent calls `query_carrier_capacity` independently and returns a concise summary (transit days, rate/TEU, capacity, reliability)
     * Intermediate subagent tool executions remain isolated in their own subagent threads, returning only condensed findings to the root context
         │
         ▼
[Step 3: Guardrail & Cost-Band Filtering]
   - Max Cost Ceiling: ≤ 50% unit price increase over primary supplier
   - Minimum Reliability Score: ≥ 0.75
   - Lead Time Constraint: ≤ 30 days AND `lead_time_days < Days of Supply`
         │
         ▼
[Step 4: Multi-Criteria Optimization & Ranked Recommendation]
   - Generate and execute a Python cost-optimization script in TrueForge's sandbox via `exec` (or call `run_cost_optimization`)
   - Weigh trade-offs using Multi-Criteria Decision Analysis:
     * Landed Cost: 40% (0.40) weight
     * Lead Time: 30% (0.30) weight
     * Reliability: 30% (0.30) weight
   - Output a human-readable ranked table (Rank, Supplier Name, Landed Cost, Lead Time, Reliability, Composite Score, Status)
   - Ensure the balanced compliant supplier outranks cheap-but-slow alternatives that exceed stockout thresholds
         │
         ▼
[Step 5: Human Approval Gate & PO Amendment]
   - Call `propose_po_amendment` with selected alternate supplier
   - TrueForge will pause execution with `tool.approval_required`
   - Operator Allow ➔ Row committed as 'approved'
   - Operator Deny ➔ Call `record_po_rejection` with operator reason
```

---

## 3. Operational Guardrails & Cost Bands

The agent must strictly enforce these quantitative boundaries when evaluating alternate suppliers:

1. **Acceptable Cost Band (Max +50% Variance)**:
   - The alternate supplier's unit cost must not exceed **1.50 × Primary Unit Cost**.
   - *Example (SKU-4471 Marine Bearings)*: Primary cost = $42.50. Cost ceiling = **$63.75**.
   - Any alternate charging > $63.75 must be rejected as economically unacceptable.
2. **Minimum Reliability Floor (≥ 0.75)**:
   - Only suppliers with `reliability_score >= 0.75` are eligible for emergency substitution.
3. **Lead Time Arrival Guarantee**:
   - The alternate supplier's lead time must be **≤ 30 days**.
   - The quoted lead time must arrive **strictly before** the calculated stockout date (`lead_time_days < Days of Supply`).
   - If stockout is projected in 20 days, a supplier with a 28-day lead time is disqualified even if cheaper.

### Scenario Reference Matrix (SKU-4471):
- **Oceanic Bearings Ltd** (ID: 1, East China Sea): $42.50, 14d, 0.94 ➔ **COMPROMISED** (Typhoon)
- **IndoPacific Parts Corp** (ID: 4, Southeast Asia): $47.50 (+11.8%), 12d, 0.89 ➔ **RECOMMENDED** (Arrives before stockout, low cost variance, high reliability)
- **Pacific Marine Supply** (ID: 2, West Coast US): $62.00 (+45.9%), 7d, 0.82 ➔ **VIABLE EXPEDITED** (Fastest delivery, within +50% cost band)
- **Baltic Precision GmbH** (ID: 3, Northern Europe): $38.00 (-10.6%), 28d, 0.96 ➔ **CONTINGENT** (Disqualified if stockout < 28 days)

---

## 4. PO Amendment Protocol & Generative UI

- When proposing an amendment, always provide a clear comparison of:
  * Primary supplier vs Selected alternate
  * Total financial variance
  * Days of safety buffer preserved
- **Hard Gate Enforcement**: Never assume human approval. The write tool `propose_po_amendment` is gated by TrueForge.
- If the operator denies approval, promptly invoke `record_po_rejection` to record the operator's rejection notes into the permanent audit ledger.
- Never attempt direct SQL modifications on `suppliers` or `inventory` tables.
