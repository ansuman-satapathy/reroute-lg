import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set isolated test database path before loading db modules
const testDbPath = path.resolve(__dirname, '../../data/test-erp-isolated.db');
const masterDbPath = path.resolve(__dirname, '../../data/erp.db');

process.env.DATABASE_PATH = testDbPath;

import { getErpDb, getErpWriteDb } from './src/db.js';
import { createErpMcpServer } from './src/index.js';
import { handleProposePoAmendment } from './src/tools/propose-po-amendment.js';
import { handleQueryCarrierCapacity } from './src/tools/query-carrier-capacity.js';
import { handleReadInventory } from './src/tools/read-inventory.js';
import { handleReadPurchaseOrders } from './src/tools/read-purchase-orders.js';
import { handleReadSuppliers } from './src/tools/read-suppliers.js';
import { handleRecordPoRejection } from './src/tools/record-po-rejection.js';
import { handleRunCostOptimization } from './src/tools/run-cost-optimization.js';

async function runErpTests() {
  console.log('🧪 Starting ERP MCP Server Test Suite with Isolated Test DB...');

  // Ensure master database exists
  if (!fs.existsSync(masterDbPath)) {
    throw new Error(`Master database not found at ${masterDbPath}. Run 'npm run db:init' first.`);
  }

  // Create isolated copy for testing
  fs.copyFileSync(masterDbPath, testDbPath);

  try {
    // 1. Test Server Instantiation and Tool Registration
    const server = createErpMcpServer();
    const registered = (server as any)._registeredTools;
    const toolNames = Object.keys(registered);

    console.log('🔍 Registered tools in McpServer:', toolNames);

    // Verify read tools have readOnlyHint: true
    const expectedReadTools = [
      'read_inventory',
      'read_suppliers',
      'read_purchase_orders',
      'query_carrier_capacity',
      'run_cost_optimization',
    ];
    for (const expected of expectedReadTools) {
      if (!toolNames.includes(expected)) {
        throw new Error(`❌ Missing expected read tool registration: ${expected}`);
      }
      const tool = registered[expected];
      if (!tool.annotations?.readOnlyHint) {
        throw new Error(`❌ Tool ${expected} must have readOnlyHint: true annotation`);
      }
    }

    // Verify write tools have readOnlyHint: false (Qodo #1)
    const expectedWriteTools = ['propose_po_amendment', 'record_po_rejection'];
    for (const expected of expectedWriteTools) {
      if (!toolNames.includes(expected)) {
        throw new Error(`❌ Missing expected write tool registration: ${expected}`);
      }
      const tool = registered[expected];
      if (tool.annotations?.readOnlyHint !== false) {
        throw new Error(`❌ Tool ${expected} must have readOnlyHint: false annotation`);
      }
    }
    console.log('✅ Qodo #1 Fixed: propose_po_amendment and record_po_rejection correctly registered with readOnlyHint: false');

    // 2. Test query_carrier_capacity Tool on All 3 Carrier Fixtures (Ticket #08)
    console.log('\n🔍 Testing query_carrier_capacity tool on all 3 carrier fixtures...');
    const maersk = await handleQueryCarrierCapacity({ carrier: 'maersk-pacific' });
    if (!maersk.success || maersk.carrier_id !== 'maersk-pacific' || maersk.rate_per_teu_usd !== 2850) {
      throw new Error(`❌ Maersk fixture query failed: ${JSON.stringify(maersk)}`);
    }
    console.log(`✅ Maersk Pacific capacity query verified: ${maersk.available_teu_capacity} TEU, $${maersk.rate_per_teu_usd}/TEU, ${maersk.transit_time_days} days`);

    const evergreen = await handleQueryCarrierCapacity({ carrier: 'evergreen-express' });
    if (!evergreen.success || evergreen.carrier_id !== 'evergreen-express' || evergreen.rate_per_teu_usd !== 1920) {
      throw new Error(`❌ Evergreen fixture query failed: ${JSON.stringify(evergreen)}`);
    }
    console.log(`✅ Evergreen Express capacity query verified: ${evergreen.available_teu_capacity} TEU, $${evergreen.rate_per_teu_usd}/TEU, ${evergreen.transit_time_days} days`);

    const cma = await handleQueryCarrierCapacity({ carrier: 'cma-cgm-asia' });
    if (!cma.success || cma.carrier_id !== 'cma-cgm-asia' || cma.rate_per_teu_usd !== 4200) {
      throw new Error(`❌ CMA CGM fixture query failed: ${JSON.stringify(cma)}`);
    }
    console.log(`✅ CMA CGM Asia capacity query verified: ${cma.available_teu_capacity} TEU, $${cma.rate_per_teu_usd}/TEU, ${cma.transit_time_days} days`);

    // Test matching and mismatching route_corridor filtering (Qodo #1 on PR #8)
    const matchingCorridor = await handleQueryCarrierCapacity({
      carrier: 'maersk-pacific',
      route_corridor: 'West Coast',
    });
    if (!matchingCorridor.success || !matchingCorridor.corridor_matched) {
      throw new Error('❌ Expected successful route_corridor match for West Coast!');
    }
    console.log('✅ Qodo #1 Fixed: Matching corridor query succeeded');

    try {
      await handleQueryCarrierCapacity({
        carrier: 'maersk-pacific',
        route_corridor: 'Mediterranean / Black Sea',
      });
      throw new Error('❌ Allowed query for mismatched route corridor!');
    } catch (err: any) {
      if (err.message.includes('does not service requested route corridor')) {
        console.log('✅ Qodo #1 Fixed: Mismatched corridor query correctly rejected with clear explanation');
      } else {
        throw err;
      }
    }

    // Test unknown carrier rejection
    try {
      await handleQueryCarrierCapacity({ carrier: 'invalid-phantom-carrier' });
      throw new Error('❌ Allowed query for unknown carrier!');
    } catch (err: any) {
      if (err.message.includes('Unknown carrier')) {
        console.log('✅ Unknown carrier rejected with available options list');
      } else {
        throw err;
      }
    }

    // 3. Test run_cost_optimization Tool (Ticket #09)
    console.log('\n🔍 Testing run_cost_optimization tool execution and multi-criteria scoring...');
    const optResult = await handleRunCostOptimization({ sku: 'SKU-4471', units: 500 });
    if (!optResult.success || !Array.isArray(optResult.ranked_suppliers)) {
      throw new Error(`❌ Cost optimization failed: ${JSON.stringify(optResult)}`);
    }

    const ranked = optResult.ranked_suppliers;
    if (ranked.length < 3) {
      throw new Error(`❌ Expected at least 3 ranked alternate suppliers for SKU-4471, found ${ranked.length}`);
    }

    // Sanity check: Balanced compliant supplier (IndoPacific) must outrank Baltic
    const topSupplier = optResult.top_recommendation;
    if (!topSupplier || !topSupplier.eligible) {
      throw new Error(`❌ Expected eligible top recommendation, got: ${JSON.stringify(topSupplier)}`);
    }
    console.log(`✅ Top ranked supplier: ${topSupplier.supplier_name} (Composite: ${topSupplier.composite_score})`);

    const baltic = ranked.find((s: any) => s.supplier_name.includes('Baltic'));
    const indoPacific = ranked.find((s: any) => s.supplier_name.includes('IndoPacific'));
    const pacificMarine = ranked.find((s: any) => s.supplier_name.includes('Pacific Marine'));

    if (!indoPacific || !baltic) {
      throw new Error('❌ Missing IndoPacific or Baltic in ranked suppliers!');
    }

    if (indoPacific.composite_score <= baltic.composite_score) {
      throw new Error(
        `❌ Sanity Check Failed: IndoPacific must outrank cheap-but-slow Baltic (Indo: ${indoPacific.composite_score}, Baltic: ${baltic.composite_score})`
      );
    }
    console.log(`✅ Sanity Check Passed: IndoPacific (${indoPacific.composite_score}) outranks Baltic (${baltic.composite_score})`);

    // Test non-existent SKU rejection (Qodo #1)
    try {
      await handleRunCostOptimization({ sku: 'NON-EXISTENT-SKU-9999' });
      throw new Error('❌ Allowed optimization for non-existent SKU!');
    } catch (err: any) {
      if (err.message.includes('not found in ERP inventory')) {
        console.log('✅ Qodo #1 Fixed: Non-existent SKU correctly rejected by cost optimizer');
      } else {
        throw err;
      }
    }

    // Test all-ineligible candidates returns top_recommendation: null (Qodo #3)
    const allIneligibleResult = await handleRunCostOptimization({
      sku: 'SKU-4471',
      candidates: [
        {
          supplier_name: 'Overpriced Supplier',
          unit_cost: 150.00, // Exceeds +50% ceiling ($63.75)
          lead_time_days: 45, // Exceeds 30 days & DoS
          reliability_score: 0.60, // Below 0.75 floor
        },
      ],
    });
    if (allIneligibleResult.top_recommendation !== null) {
      throw new Error(`❌ Qodo #3 Failed: Ineligible candidate returned as recommendation: ${JSON.stringify(allIneligibleResult.top_recommendation)}`);
    }
    console.log('✅ Qodo #3 Fixed: When no candidate is eligible, top_recommendation is null');

    // 4. Test Enforced Write Boundary (Qodo #3)
    console.log('\n🔍 Testing strict table mutation allowlist in getErpWriteDb()...');
    const writeDb = await getErpWriteDb();
    try {
      writeDb.prepare('UPDATE suppliers SET name = "Hacker Corp" WHERE id = 1').run();
      throw new Error('❌ Security check failed: Allowed mutation on suppliers table!');
    } catch (err: any) {
      if (err.message.includes('Security Policy Violation')) {
        console.log('✅ Qodo #3 Fixed: Forbidden mutation on suppliers table successfully blocked by security policy');
      } else {
        throw err;
      }
    }

    try {
      writeDb.prepare('DELETE FROM inventory WHERE id = 1').run();
      throw new Error('❌ Security check failed: Allowed mutation on inventory table!');
    } catch (err: any) {
      if (err.message.includes('Security Policy Violation')) {
        console.log('✅ Qodo #3 Fixed: Forbidden mutation on inventory table successfully blocked by security policy');
      } else {
        throw err;
      }
    }

    // 3. Test Invalid SKU & Offering Rejection (Qodo #2)
    console.log('\n🔍 Testing invalid item/offering rejection in write tools...');
    try {
      await handleProposePoAmendment({
        sku: 'SKU-DOES-NOT-EXIST',
        supplier_id: 4,
        quantity: 100,
      });
      throw new Error('❌ Validation failed: Allowed propose_po_amendment with non-existent SKU!');
    } catch (err: any) {
      if (err.message.includes('does not exist in inventory')) {
        console.log('✅ Qodo #2 Fixed: Non-existent SKU correctly rejected');
      } else {
        throw err;
      }
    }

    // Test supplier not offering the SKU (e.g. supplier 5 does not offer SKU-4471)
    try {
      await handleProposePoAmendment({
        sku: 'SKU-4471',
        supplier_id: 5, // Nippon Hydraulics does not offer Marine Bearings
        quantity: 100,
      });
      throw new Error('❌ Validation failed: Allowed propose_po_amendment for supplier not offering item!');
    } catch (err: any) {
      if (err.message.includes('does not have a registered offering')) {
        console.log('✅ Qodo #2 Fixed: Unquoted SKU for supplier correctly rejected without fallback pricing');
      } else {
        throw err;
      }
    }

    // Test Guardrail Enforcement (Qodo #1 & #2 on PR #7)
    console.log('\n🔍 Testing deterministic guardrail enforcement in handleProposePoAmendment...');
    // Baltic Precision (ID 3) has lead time 28 days > 14 Days of Supply (140 stock / 10 burn rate)
    try {
      await handleProposePoAmendment({
        sku: 'SKU-4471',
        supplier_id: 3,
        quantity: 100,
      });
      throw new Error('❌ Guardrail failed: Allowed supplier with lead time exceeding stockout date!');
    } catch (err: any) {
      if (err.message.includes('exceeds available Days of Supply')) {
        console.log('✅ Qodo #1 & #2 Fixed: Supplier exceeding stockout date correctly rejected by guardrail:');
        console.log(`   Message: "${err.message}"`);
      } else {
        throw err;
      }
    }

    // 4. Test Valid propose_po_amendment
    console.log('\n🔍 Testing valid propose_po_amendment execution...');
    const amendedPo = await handleProposePoAmendment({
      sku: 'SKU-4471',
      supplier_id: 4, // IndoPacific Parts Corp
      quantity: 200,
      notes: 'Approved alternate supplier substitution due to East China Sea weather disruption',
    });

    if (!amendedPo.success || amendedPo.status !== 'approved') {
      throw new Error(`❌ Expected approved PO status, got: ${JSON.stringify(amendedPo)}`);
    }
    if (amendedPo.unit_cost !== 47.50 || amendedPo.total_cost !== 9500.00) {
      throw new Error(`❌ Calculation error: expected unit $47.50, total $9500.00`);
    }
    console.log(`✅ propose_po_amendment created PO #${amendedPo.po_id} with status='approved' and total $${amendedPo.total_cost}`);

    // 5. Test Valid record_po_rejection
    console.log('\n🔍 Testing valid record_po_rejection execution...');
    const rejectionRecord = await handleRecordPoRejection({
      sku: 'SKU-4471',
      supplier_id: 2, // Pacific Marine Supply
      quantity: 200,
      reason: 'Rejected by operator: Unit price ($62.00) exceeds maximum acceptable budget threshold',
    });

    if (!rejectionRecord.success || rejectionRecord.status !== 'rejected') {
      throw new Error(`❌ Expected rejected PO status, got: ${JSON.stringify(rejectionRecord)}`);
    }
    console.log(`✅ record_po_rejection logged audit PO #${rejectionRecord.po_id} with status='rejected'`);

    // 6. Verify read_purchase_orders reflects both new orders
    const updatedPos = await handleReadPurchaseOrders({});
    const approvedPo = updatedPos.purchase_orders.find((p) => p.id === amendedPo.po_id);
    const rejectedPo = updatedPos.purchase_orders.find((p) => p.id === rejectionRecord.po_id);

    if (!approvedPo || approvedPo.status !== 'approved') {
      throw new Error(`❌ Approved PO #${amendedPo.po_id} not found via read_purchase_orders!`);
    }
    if (!rejectedPo || rejectedPo.status !== 'rejected') {
      throw new Error(`❌ Rejected PO #${rejectionRecord.po_id} not found via read_purchase_orders!`);
    }
    console.log('✅ Both approved and rejected POs queryable in database');

    console.log('\n🎉 ALL Ticket #03 acceptance tests & Qodo review assertions PASSED successfully!');
  } finally {
    // Qodo #4: Cleanup isolated test database in finally block
    try {
      const readDb = await getErpDb();
      readDb.close();
    } catch {}
    try {
      const writeDb = await getErpWriteDb();
      writeDb.close();
    } catch {}
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
      console.log('🧹 Isolated test database cleaned up in finally block (Qodo #4 Fixed).');
    }
  }
}

runErpTests().catch((err) => {
  console.error('\n❌ ERP MCP Server test failed:', err);
  process.exit(1);
});
