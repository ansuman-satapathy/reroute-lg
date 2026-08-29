# Software Requirements Specification (SRS)

## ReRoute-LG: Autonomous Supply-Chain Disruption Triage System

**Document Version:** 1.0.0  
**Status:** Approved & Verified  
**Standard:** IEEE 830-1998 Compatible  

---

## 1. Introduction

### 1.1 Purpose
This document specifies the software requirements for **ReRoute-LG**, an autonomous supply-chain disruption triage agent built upon the **TrueForge Agent Harness** and the **Model Context Protocol (MCP)** standard. It provides a definition of all Functional Requirements (`FR-1` through `FR-23`) and Non-Functional Requirements (`NFR-1` through `NFR-5`) cited across the project's commit history, pull requests, and automated test suites.

### 1.2 Scope & System Overview
ReRoute-LG monitors supply-chain corridors for disruption events (e.g. typhoons, port strikes, dredging advisories). Upon alert ingestion, the system corroborates ground-truth conditions using live weather and news feeds, calculates inventory buffer depletion (Days of Supply), discovers and filters candidate alternate suppliers against cost-band and reliability guardrails, runs multi-criteria mathematical optimization, renders a **Generative UI PO Diff**, and pauses for mandatory human authorization before committing any purchase order amendments to the enterprise ledger.

---

## 2. Functional Requirements Catalog

### Domain 1: Agent Runtime Harness & TrueForge Integration
- **`FR-1` — Agent Harness Initialization**: The system must deploy and configure a stateful autonomous triage agent (`disruption-triage-agent`) within the TrueForge runtime harness using `@truefoundry/trueforge-sdk`.
- **`FR-2` — Model Configuration & Steering**: The agent harness must interface with an advanced reasoning model (`nvidia-nim/nemotron-3-super-120b-a12b`) configured with deterministic sampling parameters (`temperature: 0.6`, `topP: 0.95`).
- **`FR-3` — Stateful Session & Turn Management**: The harness must support persistent multi-turn sessions where agent memory, conversation context, and prior tool outputs are preserved across execution pauses.
- **`FR-4` — MCP Connector Hub**: The agent harness must establish bidirectional Server-Sent Events (SSE) connections to modular MCP servers: ERP MCP (`http://localhost:3001/sse`) and Telemetry MCP (`http://localhost:3002/sse`).
- **`FR-5` — SOP Skill Attachment**: The harness must inject the authoritative Disruption Triage Standard Operating Procedure (`skills/disruption-triage/SKILL.md`) into the agent's system prompt context.

### Domain 2: External Disruption Telemetry (Telemetry MCP)
- **`FR-6` — Live Marine Weather Corroboration**: The Telemetry MCP server must provide a `get_weather_alerts` tool fetching live wind speeds, wind gusts, wave height, and precipitation from the Open-Meteo Marine Weather API.
- **`FR-7` — Live News & Labor Dispute Corroboration**: The Telemetry MCP server must provide a `get_news_disruptions` tool querying live Google News RSS feeds for labor strikes, geopolitical sanctions, and terminal closures.
- **`FR-8` — Telemetry Normalization & Authoritative Severity**: All telemetry tools must normalize responses into a structured schema (`{type, severity, region, summary, details}`). Incoming alert severity remains authoritative for triage activation, with telemetry providing real-time corroboration and enrichment.

### Domain 3: ERP Ledger & Data Access (ERP MCP)
- **`FR-9` — Inventory Buffer Analysis**: The ERP MCP server must expose a `read_inventory` tool calculating current on-hand stock, reorder thresholds, daily burn rates, and projected **Days of Supply (DoS)**:
  `Days of Supply = Current Stock / Daily Burn Rate`
- **`FR-10` — Alternate Supplier Discovery**: The ERP MCP server must expose a `read_suppliers` tool querying suppliers by SKU, returning origin region, unit cost, contracted lead time (days), and historical reliability rating in range [0.0, 1.0].
- **`FR-11` — Freight Carrier Capacity Queries**: The ERP MCP server must expose a `query_carrier_capacity` tool validating ocean carrier allocations (TEU), transit durations, and per-container freight rates for specific shipping corridors (e.g. Maersk Pacific, Evergreen Express, CMA CGM Asia).
- **`FR-11a` — Strict Table Mutation Allowlist**: To prevent unauthorized tampering, write operations in the ERP database must be strictly restricted to the `purchase_orders` table; mutations on `suppliers`, `inventory`, or `supplier_catalog` must be rejected with a security error.

### Domain 4: Operational Guardrails & Business SOP
- **`FR-12` — Severity-Based Routing Rules**: The agent must trigger autonomous triage only for `HIGH` severity events in monitored supplier corridors. `LOW` severity advisories (e.g. routine dredging, delay < 4 hours) must be logged as informational notices without initiating supplier re-routing or PO creation.
- **`FR-13` — Cost-Band Ceiling Guardrail**: Alternate suppliers whose unit cost exceeds +50% of the primary supplier's contracted rate must be disqualified:
  `Unit Cost (alternate) <= 1.50 * Unit Cost (primary)`
- **`FR-14` — Reliability Threshold Guardrail**: Alternate suppliers with historical reliability ratings below 0.75 (75%) must be disqualified.
- **`FR-15` — Stockout Lead-Time Constraint**: Alternate suppliers whose lead time equals or exceeds available Days of Supply must be disqualified to prevent stockout:
  `Lead Time (alternate) < Days of Supply`

### Domain 5: Subagent Delegation & Parallel Queries
- **`FR-16` — Subagent Delegation**: When multiple logistics corridors or carrier routes must be evaluated simultaneously, the agent must spawn parallel subagents using TrueForge's `create_sub_agent`.
- **`FR-17` — Subagent Trace Observability**: Subagent traces, inputs, and outputs must be visible in the parent session thread with typed parent-child linkages.

### Domain 6: Multi-Criteria Cost Optimization
- **`FR-18` — Mathematical Scoring Function**: The system must provide a multi-criteria scoring algorithm weighting candidate trade-offs:
  `Score = 0.40 * (1 - norm_cost) + 0.30 * (1 - norm_lead_time) + 0.30 * reliability`
  *(where norm_cost is normalized landed cost, norm_lead_time is normalized lead time, and reliability is the supplier reliability rating)*.
- **`FR-19` — Ranked Recommendation Table**: The optimization engine must output a ranked Markdown table detailing Rank, Supplier Name, Landed Cost, Lead Time, Reliability Score, Composite Score, and Compliance Status.

### Domain 7: Generative UI & Human Approval Gate
- **`FR-20` — Generative UI PO Diff**: Before requesting authorization, the agent must render a Markdown comparison table in the chat interface contrasting the baseline purchase order against the proposed alternate across 8 metrics (Supplier Name, Origin Corridor, Unit Cost, Lead Time, Reliability, Order Quantity, Total PO Value, and Guardrail Compliance).
- **`FR-21` — TrueForge Human Approval Gate**: The `propose_po_amendment` tool must be gated with `approval: required`. When invoked, TrueForge must pause agent execution and emit a `tool.approval_required` event with an interactive UI modal.
- **`FR-22` — Operator Approval Path (`allow`)**: Upon receiving `user.tool_approval` with `status: 'allow'`, the gated tool must execute, inserting a new row into `purchase_orders` with `status: 'approved'`.
- **`FR-23` — Operator Denial & Audit Path (`deny`)**: Upon receiving `user.tool_approval` with `status: 'deny'`, the gated tool must NOT execute; the agent must invoke `record_po_rejection` to record an audit row in `purchase_orders` with `status: 'rejected'` and operator justification notes.

---

## 3. Non-Functional Requirements (NFRs)

- **`NFR-1` — Security & Secret Management**: No API keys, credentials, or private tokens may be checked into version control. Local configurations must load through `.env` with strict gitignore enforcement.
- **`NFR-2` — Execution Latency**: End-to-end autonomous triage from alert ingestion to the human approval gate must complete in under 90 seconds (measured latency typically 30–60 seconds across test runs, e.g. 32.23s–46.27s), comfortably fitting within a 3-minute video demonstration.
- **`NFR-3` — Deterministic Tool Calling**: Model steering parameters and schema definitions must prevent tool hallucination, ensuring tool names and arguments adhere strictly to MCP schemas (no observed schema hallucinations across automated test runs).
- **`NFR-4` — Purchase Order Idempotency**: Repeated invocations of `propose_po_amendment` for the same canonical SKU and supplier within a 24-hour window must return `duplicate: true` and preserve the existing order without creating redundant database entries.
- **`NFR-5` — Auditability & Reconstructability**: Every triage run must generate a typed event log in TrueForge (`turn.created`, `tool_calls`, `tool.approval_required`, `user.tool_approval`, `tool.response`), allowing complete audit replay for review.

---

## 4. Requirements Traceability Matrix (RTM)

The matrix below maps each requirement to its corresponding ticket, implementation PR, code artifacts, and automated verification suites:

| Req ID | Description | Ticket # | PR # | Source Code Files | Verification Test / Command | Status |
|:---|:---|:---:|:---:|:---|:---|:---:|
| **`FR-1`** | Agent Harness Init | #05 | #5 | `trueforge/agent-config.ts` | `npm run test:agent` | Verified |
| **`FR-2`** | Model Steering (Nemotron) | #05, #11 | #5, #11 | `trueforge/agent-config.ts` | `npm run test:agent` | Verified |
| **`FR-3`** | Stateful Session & Turns | #05, #10 | #5, #10 | `trueforge/agent-config.ts`, `test/test-approval-gate.ts` | `npm run test:approval` | Verified |
| **`FR-4`** | Modular MCP Connectors | #01, #05 | #1, #5 | `scripts/start-mcp-servers.ts`, `trueforge/agent-config.ts` | `npm run start:mcp` | Verified |
| **`FR-5`** | SOP Skill Attachment | #01, #05, #07 | #1, #5, #7 | `skills/disruption-triage/SKILL.md` | `npm run test:skill` | Verified |
| **`FR-6`** | Live Marine Weather API | #04 | #4 | `mcp-servers/telemetry/src/tools/get-weather-alerts.ts` | `npm run test:telemetry` | Verified |
| **`FR-7`** | Live News & Strike RSS | #04 | #4 | `mcp-servers/telemetry/src/tools/get-news-disruptions.ts` | `npm run test:telemetry` | Verified |
| **`FR-8`** | Telemetry Normalization | #04 | #4 | `mcp-servers/telemetry/src/types.ts` | `npm run test:telemetry` | Verified |
| **`FR-9`** | Inventory Buffer & DoS | #02, #06 | #2, #6 | `mcp-servers/erp/src/tools/read-inventory.ts` | `npm run test:erp`, `npm run test:inject-alert` | Verified |
| **`FR-10`** | Alternate Supplier Lookup | #02, #06 | #2, #6 | `mcp-servers/erp/src/tools/read-suppliers.ts` | `npm run test:erp`, `npm run test:inject-alert` | Verified |
| **`FR-11`** | Freight Carrier Capacity | #03 | #3 | `mcp-servers/erp/src/tools/query-carrier-capacity.ts` | `npm run test:erp` | Verified |
| **`FR-11a`** | Table Mutation Allowlist | #03 | #3 | `mcp-servers/erp/src/db.ts` | `npm run test:erp` | Verified |
| **`FR-12`** | Severity-Based Routing | #07, #11 | #7, #11 | `skills/disruption-triage/SKILL.md`, `scripts/inject-alert.ts` | `npm run inject-alert:low` | Verified |
| **`FR-13`** | Cost Ceiling (+50%) Guardrail | #07 | #7 | `skills/disruption-triage/SKILL.md`, `mcp-servers/erp/src/tools/propose-po-amendment.ts` | `npm run test:erp`, `npm run test:skill` | Verified |
| **`FR-14`** | Minimum Reliability (0.75) | #07 | #7 | `skills/disruption-triage/SKILL.md` | `npm run test:skill` | Verified |
| **`FR-15`** | Lead Time < Days of Supply | #07 | #7 | `skills/disruption-triage/SKILL.md`, `mcp-servers/erp/src/tools/propose-po-amendment.ts` | `npm run test:erp`, `npm run test:skill` | Verified |
| **`FR-16`** | Parallel Subagents | #08 | #8 | `test/test-subagents.ts` | `npm run test:subagents` | Verified |
| **`FR-17`** | Subagent Trace Observability | #08 | #8 | `test/test-subagents.ts` | `npm run test:subagents` | Verified |
| **`FR-18`** | Scoring Algorithm (0.4 / 0.3 / 0.3) | #09 | #9 | `scripts/cost-optimization.py`, `mcp-servers/erp/src/tools/run-cost-optimization.ts` | `npm run test:optimization` | Verified |
| **`FR-19`** | Ranked Recommendation Table | #09 | #9 | `mcp-servers/erp/src/tools/run-cost-optimization.ts` | `npm run test:optimization` | Verified |
| **`FR-20`** | Generative UI PO Diff | #10 | #10 | `skills/disruption-triage/SKILL.md`, `test/test-approval-gate.ts` | `npm run test:approval` | Verified |
| **`FR-21`** | TrueForge Approval Gate | #10 | #10 | `trueforge/agent-config.ts`, `test/test-approval-gate.ts` | `npm run test:approval` | Verified |
| **`FR-22`** | Operator Allow Path (Commit) | #10 | #10 | `mcp-servers/erp/src/tools/propose-po-amendment.ts` | `npm run test:approval` | Verified |
| **`FR-23`** | Operator Deny Path (Audit Log) | #10 | #10 | `mcp-servers/erp/src/tools/record-po-rejection.ts` | `npm run test:approval` | Verified |
| **`NFR-1`** | Secret Management | #01 | #1 | `.gitignore`, `.env.example` | `git log -p` audit | Verified |
| **`NFR-2`** | Sub-90s Triage Latency | #11 | #11 | `scripts/demo-time.ts` | `npm run demo:time` (32s–60s) | Verified |
| **`NFR-3`** | Deterministic Tool Calling | #05, #11 | #5, #11 | `trueforge/agent-config.ts` (`temp: 0.6`) | `npm run test:agent` | Verified |
| **`NFR-4`** | 24h PO Idempotency Guard | #11 | #11 | `mcp-servers/erp/src/tools/propose-po-amendment.ts` | Isolated unit invocation | Verified |
| **`NFR-5`** | Typed Audit Trail Replay | #10 | #10 | `test/test-approval-gate.ts` | `npm run test:approval` | Verified |
