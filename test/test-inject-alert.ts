import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getErpDb } from '../mcp-servers/erp/src/db.js';
import { injectDisruptionAlert } from '../scripts/inject-alert.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runInjectAlertTests() {
  console.log('🧪 Starting Alert Ingestion & Disruption Detection Test (Ticket #06)...');

  // 1. Validate Fixture Structure (Criteria 1)
  const fixturePath = path.resolve(__dirname, '../fixtures/disruption-alert.json');
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`❌ Missing required fixture file: ${fixturePath}`);
  }

  const alert = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  if (alert.severity !== 'high') {
    throw new Error(`❌ Fixture alert must have severity: "high", got: ${alert.severity}`);
  }
  if (alert.region !== 'East China Sea') {
    throw new Error(`❌ Fixture alert must have region: "East China Sea", got: ${alert.region}`);
  }
  console.log('✅ Criteria 1 Passed: fixtures/disruption-alert.json is well-formed with severity="high" & region="East China Sea"');

  // 2. Validate Causal Link in Seed Database (Criteria 4)
  console.log('\n🔍 Verifying causal match in ERP seed database...');
  const db = await getErpDb();
  const primarySupplier = db
    .prepare(
      `SELECT s.id, s.name, s.region, i.sku, i.item_name
       FROM inventory i
       JOIN suppliers s ON i.primary_supplier_id = s.id
       WHERE s.region = ? AND i.sku = 'SKU-4471'`
    )
    .get(alert.region) as any;

  if (!primarySupplier) {
    throw new Error(`❌ No primary supplier found matching alert region '${alert.region}' in ERP database!`);
  }

  if (primarySupplier.sku !== 'SKU-4471') {
    throw new Error(`❌ Primary supplier in ${alert.region} is not linked to core scenario item SKU-4471`);
  }

  console.log(`✅ Criteria 4 Passed: Causal link confirmed:`);
  console.log(`   - Disrupted Region in Alert: "${alert.region}"`);
  console.log(`   - Primary Compromised Supplier: "${primarySupplier.name}" (ID: ${primarySupplier.id}, SKU: ${primarySupplier.sku})`);

  // 3. Inject Alert via TrueForge Harness and verify autonomous execution (Criteria 2 & 3)
  console.log('\n🔍 Injecting alert into TrueForge session and monitoring agent triage...');
  const result = await injectDisruptionAlert(fixturePath);

  if (!result.sessionId || !result.turnId) {
    throw new Error('❌ Alert injection failed to return valid session/turn IDs');
  }
  console.log(`✅ Criteria 2 Passed: Alert posted to active agent session (${result.sessionId})`);

  // Fix for Qodo #2: Require confirmed execution of BOTH read_inventory and read_suppliers
  const hasInventory = result.toolsCalled.includes('read_inventory');
  const hasSuppliers = result.toolsCalled.includes('read_suppliers');

  if (!hasInventory || !hasSuppliers) {
    throw new Error(
      `❌ Agent failed required autonomous checks. Expected both 'read_inventory' and 'read_suppliers'. Executed tools: [${result.toolsCalled.join(', ')}]`
    );
  }

  // Fix for Qodo #4: Explicitly assert non-empty response content
  if (!result.agentResponse || !result.agentResponse.trim()) {
    throw new Error(
      '❌ Agent completed turn without producing any non-empty triage assessment or recommendation response!'
    );
  }

  console.log(`✅ Criteria 3 Passed: Agent autonomously executed both inventory and supplier evaluations with non-empty response:`);
  console.log(`   - Inventory Checked: ${hasInventory}`);
  console.log(`   - Suppliers Checked: ${hasSuppliers}`);
  console.log(`   - Total Tools Executed: [${result.toolsCalled.join(', ')}]`);
  console.log(`   - Agent Response Length: ${result.agentResponse.trim().length} chars`);

  console.log('\n🎉 ALL Ticket #06 acceptance tests PASSED successfully!');
}

runInjectAlertTests().catch((err) => {
  console.error('\n❌ Alert ingestion test failed:', err);
  process.exit(1);
});
