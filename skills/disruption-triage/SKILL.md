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
[Step 0: Live Telemetry Corroboration]
   - MANDATORY FIRST STEP before any ERP queries.
   - Route the corroboration call by alert type:
     * Weather-type alerts (typhoon, storm, flooding, port weather closure) → call `get_weather_alerts` for the affected region coordinates
     * Labor / geopolitical alerts (strike, embargo, sanctions, port blockade) → call `get_news_disruptions` for the affected region
     * If the alert type does not map cleanly to either signal source → skip corroboration entirely and proceed to Step 1 on the incoming alert alone
   - The INCOMING ALERT's severity is always authoritative for triggering triage, regardless of what telemetry returns. Apply the following outcomes:
     * Telemetry CONFIRMS alert severity → proceed to Step 1 and note confirmation in your response (e.g. "Live weather data confirms severe conditions at lat 30.6°N, 126.0°E")
     * Telemetry DIVERGES from alert severity (e.g. weather shows clear sky despite typhoon alert) → proceed to Step 1 on the alert alone; explicitly flag the discrepancy (e.g. "Note: live weather models currently show moderate conditions — signals may lag rapidly developing storm systems. Proceeding on authoritative alert.")
     * Telemetry call FAILS, times out, or returns no data → proceed to Step 1 on the alert alone; note that live corroboration was unavailable (e.g. "Telemetry feed unavailable — proceeding on incoming alert severity.")
   - Always surface whatever telemetry findings were returned (wind speed, storm codes, news headlines) in your response before proceeding to Step 1
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
   - You MUST generate and execute a Python cost-optimization script inside TrueForge's container sandbox using the native `exec` tool.
   - The script must calculate composite scores across eligible candidates using weights:
     * Landed Cost: 40% (0.40) weight
     * Lead Time: 30% (0.30) weight
     * Reliability: 30% (0.30) weight
   - Output a human-readable ranked table (Rank, Supplier Name, Landed Cost, Lead Time, Reliability, Composite Score, Status)
   - Ensure the highest-scoring compliant alternate supplier outside the disrupted corridor outranks cheap-but-slow alternatives that exceed stockout thresholds
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

## 4. PO Amendment Protocol & Generative UI Diff

Before invoking `propose_po_amendment`, the agent MUST render a visual Generative UI Diff (table/card) comparing the baseline PO against the proposed amendment:

### Generative UI PO Diff Specification:
The agent MUST output a visible comparison table directly in the chat response text before proposing an amendment:

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

### Human Approval Gate Execution:
1. **MANDATORY Generative UI Markdown Table**: In the exact same assistant message where you invoke `propose_po_amendment`, you MUST print the complete Markdown comparison table (`| Metric | Baseline ... |`). Do NOT output conversational placeholder text such as "Now we'll output the table in markdown" or "Let's do it" without the table; you MUST output the actual Markdown table directly in your response text.
2. **Trigger Gate**: Along with the table, invoke `propose_po_amendment` with the structured parameters. TrueForge will pause execution with `tool.approval_required`.
3. **Approve Path (Allow)**:
   - When the operator grants approval, the tool executes and commits an `approved` row to `purchase_orders`.
   - Confirm the approved PO ID, timestamp, and supplier re-route to the operator.
4. **Reject Path (Deny)**:
   - When the operator denies approval, `propose_po_amendment` is blocked and never executes.
   - The agent receives the denial and operator reason.
   - The agent MUST immediately invoke `record_po_rejection` to log an audit entry in `purchase_orders` with `status = 'rejected'` and the denial rationale.
   - Never attempt direct SQL modifications on `suppliers` or `inventory` tables.
