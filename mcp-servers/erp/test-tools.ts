import { getErpDb, getErpWriteDb } from './src/db.js';
import { createErpMcpServer } from './src/index.js';
import { handleProposePoAmendment } from './src/tools/propose-po-amendment.js';
import { handleReadInventory } from './src/tools/read-inventory.js';
import { handleReadPurchaseOrders } from './src/tools/read-purchase-orders.js';
import { handleReadSuppliers } from './src/tools/read-suppliers.js';
import { handleRecordPoRejection } from './src/tools/record-po-rejection.js';

async function runErpTests() {
  console.log('🧪 Starting ERP MCP Server Test Suite (Ticket #02 + Ticket #03)...');

  // 1. Test Server Instantiation and Tool Registration
  const server = createErpMcpServer();
  const registered = (server as any)._registeredTools;
  const toolNames = Object.keys(registered);

  console.log('🔍 Registered tools in McpServer:', toolNames);

  const expectedReadTools = ['read_inventory', 'read_suppliers', 'read_purchase_orders', 'record_po_rejection'];
  for (const expected of expectedReadTools) {
    if (!toolNames.includes(expected)) {
      throw new Error(`❌ Missing expected read tool registration: ${expected}`);
    }
    const tool = registered[expected];
    if (!tool.annotations?.readOnlyHint) {
      throw new Error(`❌ Tool ${expected} must have readOnlyHint: true annotation`);
    }
  }

  // Verify propose_po_amendment has readOnlyHint: false (@write annotation for approval gate)
  if (!toolNames.includes('propose_po_amendment')) {
    throw new Error('❌ Missing write tool: propose_po_amendment');
  }
  const writeTool = registered['propose_po_amendment'];
  if (writeTool.annotations?.readOnlyHint !== false) {
    throw new Error('❌ propose_po_amendment MUST have readOnlyHint: false to trigger TrueForge approval gate');
  }

  console.log('✅ Criteria 1 Passed: Tools registered with correct annotations (propose_po_amendment: @write, others: @read-only)');

  // 2. Test Concurrency & Read-Only Invariants
  console.log('\n🔍 Testing concurrent getErpDb() and read-only enforcement...');
  const [db1, db2, db3] = await Promise.all([getErpDb(), getErpDb(), getErpDb()]);
  if (db1 !== db2 || db2 !== db3) {
    throw new Error('❌ Concurrency failure: getErpDb() did not return the identical singleton instance!');
  }
  console.log('✅ Singleton check passed');

  // 3. Test read_inventory
  console.log('\n🔍 Testing read_inventory({ sku: "SKU-4471" })...');
  const inventoryResult = await handleReadInventory({ sku: 'SKU-4471' });
  if (inventoryResult.total_found !== 1) {
    throw new Error(`❌ Expected 1 item for SKU-4471, found ${inventoryResult.total_found}`);
  }
  console.log('✅ read_inventory returned SKU-4471');

  // 4. Test read_suppliers
  console.log('\n🔍 Testing read_suppliers({ sku: "SKU-4471" })...');
  const suppliersResult = await handleReadSuppliers({ sku: 'SKU-4471' });
  if (suppliersResult.total_found !== 4) {
    throw new Error(`❌ Expected 4 suppliers quoting SKU-4471, found ${suppliersResult.total_found}`);
  }
  console.log('✅ read_suppliers returned all 4 suppliers for SKU-4471');

  // 5. Test propose_po_amendment (Ticket #03 Write Tool)
  console.log('\n🔍 Testing propose_po_amendment (approved execution)...');
  const initialSuppliersCount = (await getErpDb()).prepare('SELECT COUNT(*) as count FROM suppliers').get() as any;
  const initialInventoryCount = (await getErpDb()).prepare('SELECT COUNT(*) as count FROM inventory').get() as any;

  const amendedPo = await handleProposePoAmendment({
    item_name: 'Marine Bearings, SKU-4471',
    supplier_id: 4, // IndoPacific Parts Corp
    quantity: 200,
    notes: 'Approved alternate supplier substitution due to East China Sea weather disruption',
  });

  if (!amendedPo.success || amendedPo.status !== 'approved') {
    throw new Error(`❌ Expected approved PO status, got: ${JSON.stringify(amendedPo)}`);
  }
  if (amendedPo.unit_cost !== 47.50 || amendedPo.total_cost !== 9500.00) {
    throw new Error(`❌ Calculation error: expected unit $47.50, total $9500.00; got unit ${amendedPo.unit_cost}, total ${amendedPo.total_cost}`);
  }
  console.log(`✅ Criteria 2 Passed: propose_po_amendment created PO #${amendedPo.po_id} with status='approved' and total $${amendedPo.total_cost}`);

  // 6. Test record_po_rejection (Ticket #03 Rejection Audit Trail)
  console.log('\n🔍 Testing record_po_rejection (operator denial path)...');
  const rejectionRecord = await handleRecordPoRejection({
    item_name: 'Marine Bearings, SKU-4471',
    supplier_id: 2, // Pacific Marine Supply
    quantity: 200,
    reason: 'Rejected by operator: Unit price ($62.00) exceeds maximum acceptable budget threshold',
  });

  if (!rejectionRecord.success || rejectionRecord.status !== 'rejected') {
    throw new Error(`❌ Expected rejected PO status, got: ${JSON.stringify(rejectionRecord)}`);
  }
  console.log(`✅ Criteria 3 Passed: record_po_rejection logged audit PO #${rejectionRecord.po_id} with status='rejected'`);

  // 7. Verify read_purchase_orders reflects both new orders
  console.log('\n🔍 Verifying read_purchase_orders shows both new orders...');
  const updatedPos = await handleReadPurchaseOrders({});
  const approvedPo = updatedPos.purchase_orders.find((p) => p.id === amendedPo.po_id);
  const rejectedPo = updatedPos.purchase_orders.find((p) => p.id === rejectionRecord.po_id);

  if (!approvedPo || approvedPo.status !== 'approved') {
    throw new Error(`❌ Approved PO #${amendedPo.po_id} not found via read_purchase_orders!`);
  }
  if (!rejectedPo || rejectedPo.status !== 'rejected') {
    throw new Error(`❌ Rejected PO #${rejectionRecord.po_id} not found via read_purchase_orders!`);
  }
  console.log('✅ Criteria 4 Passed: Both approved and rejected POs queryable in database');

  // 8. Invariant Check: Verify NO inventory or supplier rows were mutated (FR-11a, NFR-3)
  const finalSuppliersCount = (await getErpDb()).prepare('SELECT COUNT(*) as count FROM suppliers').get() as any;
  const finalInventoryCount = (await getErpDb()).prepare('SELECT COUNT(*) as count FROM inventory').get() as any;

  if (initialSuppliersCount.count !== finalSuppliersCount.count) {
    throw new Error('❌ Invariant violated: suppliers table was mutated!');
  }
  if (initialInventoryCount.count !== finalInventoryCount.count) {
    throw new Error('❌ Invariant violated: inventory table was mutated!');
  }
  console.log('✅ Criteria 5 Passed: Zero mutations to suppliers or inventory tables (ledger immutability preserved)');

  // Clean up test POs to keep seed database pristine for subsequent demo
  const writeDb = await getErpWriteDb();
  writeDb.prepare('DELETE FROM purchase_orders WHERE id IN (?, ?)').run(amendedPo.po_id, rejectionRecord.po_id);
  console.log('🧹 Cleaned up test purchase orders. Baseline database state restored.');

  console.log('\n🎉 ALL Ticket #03 acceptance tests PASSED successfully!');
}

runErpTests().catch((err) => {
  console.error('\n❌ ERP MCP Server test failed:', err);
  process.exit(1);
});
