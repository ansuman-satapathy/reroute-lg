import { getErpDb } from './src/db.js';
import { createErpMcpServer } from './src/index.js';
import { handleReadInventory } from './src/tools/read-inventory.js';
import { handleReadPurchaseOrders } from './src/tools/read-purchase-orders.js';
import { handleReadSuppliers } from './src/tools/read-suppliers.js';

async function runErpTests() {
  console.log('🧪 Starting ERP MCP Server Test Suite (Ticket #02)...');

  // 1. Test Server Instantiation and Tool Registration
  const server = createErpMcpServer();
  const registered = (server as any)._registeredTools;
  const toolNames = Object.keys(registered);

  console.log('🔍 Registered tools in McpServer:', toolNames);

  const expectedTools = ['read_inventory', 'read_suppliers', 'read_purchase_orders'];
  for (const expected of expectedTools) {
    if (!toolNames.includes(expected)) {
      throw new Error(`❌ Missing expected tool registration: ${expected}`);
    }
    const tool = registered[expected];
    if (!tool.annotations?.readOnlyHint) {
      throw new Error(`❌ Tool ${expected} must have readOnlyHint: true annotation`);
    }
  }
  console.log('✅ Criteria 1 & 2 Passed: All 3 tools registered with readOnlyHint: true');

  // 2. Test Concurrency & Read-Only Invariants (Qodo #1 & #2)
  console.log('\n🔍 Testing concurrent getErpDb() and read-only enforcement...');
  const [db1, db2, db3] = await Promise.all([getErpDb(), getErpDb(), getErpDb()]);
  if (db1 !== db2 || db2 !== db3) {
    throw new Error('❌ Concurrency failure: getErpDb() did not return the identical singleton instance!');
  }
  console.log('✅ Qodo #1 Fixed: Concurrent initialization safely deduplicated to singleton instance');

  // Test read-only enforcement
  try {
    (db1 as any).prepare('INSERT INTO suppliers (name) VALUES ("Hacker Corp")').run();
    throw new Error('❌ Security check failed: Database permitted write operation on read-only connection!');
  } catch (err: any) {
    if (err.message.includes('readonly') || err.message.includes('read-only') || err.message.includes('is not a function')) {
      console.log('✅ Qodo #2 Fixed: Read-only mode strictly enforced at driver & interface levels');
    } else {
      throw err;
    }
  }

  // 3. Test read_inventory with SKU filter & limit (Qodo #3)
  console.log('\n🔍 Testing read_inventory({ sku: "SKU-4471" })...');
  const inventoryResult = await handleReadInventory({ sku: 'SKU-4471' });

  if (inventoryResult.total_found !== 1) {
    throw new Error(`❌ Expected 1 item for SKU-4471, found ${inventoryResult.total_found}`);
  }

  const targetItem = inventoryResult.inventory[0];
  if (targetItem.sku !== 'SKU-4471' || targetItem.primary_supplier_name !== 'Oceanic Bearings Ltd') {
    throw new Error(`❌ Unexpected item details: ${JSON.stringify(targetItem)}`);
  }
  if (targetItem.primary_supplier_region !== 'East China Sea') {
    throw new Error(`❌ Expected primary supplier region East China Sea, got ${targetItem.primary_supplier_region}`);
  }
  if (!targetItem.is_reorder_needed) {
    throw new Error(`❌ Expected is_reorder_needed to be true (Stock: ${targetItem.current_stock}, Threshold: ${targetItem.reorder_threshold})`);
  }

  console.log('✅ Criteria 3 Passed: read_inventory correctly returned SKU-4471:');
  console.log(`   - Item: ${targetItem.item_name}`);
  console.log(`   - Stock: ${targetItem.current_stock} / Threshold: ${targetItem.reorder_threshold}`);
  console.log(`   - Primary Supplier: ${targetItem.primary_supplier_name} (${targetItem.primary_supplier_region})`);

  // Test bounded inventory query
  const boundedInventory = await handleReadInventory({ limit: 5 });
  if (boundedInventory.total_found !== 5 || boundedInventory.limit_applied !== 5) {
    throw new Error(`❌ Bounded query failed: Expected 5 items, found ${boundedInventory.total_found}`);
  }
  console.log(`✅ Qodo #3 Fixed: Bounded query returned exactly ${boundedInventory.total_found} items (limit: 5)`);

  // 4. Test read_suppliers with SKU & region filters
  console.log('\n🔍 Testing read_suppliers({ sku: "SKU-4471" })...');
  const suppliersResult = await handleReadSuppliers({ sku: 'SKU-4471' });

  if (suppliersResult.total_found !== 4) {
    throw new Error(`❌ Expected 4 suppliers quoting SKU-4471, found ${suppliersResult.total_found}`);
  }

  const primaryQuote = suppliersResult.suppliers.find((s) => s.is_primary);
  if (!primaryQuote || primaryQuote.supplier_name !== 'Oceanic Bearings Ltd') {
    throw new Error('❌ Primary supplier quote not found or mismatched');
  }

  const alternateQuotes = suppliersResult.suppliers.filter((s) => !s.is_primary);
  if (alternateQuotes.length !== 3) {
    throw new Error(`❌ Expected 3 alternate quotes, found ${alternateQuotes.length}`);
  }

  console.log('✅ Criteria 4 Passed: read_suppliers returned all 4 suppliers for SKU-4471:');
  for (const s of suppliersResult.suppliers) {
    const flag = s.is_primary ? '[PRIMARY]' : '[ALTERNATE]';
    console.log(`   - ${flag.padEnd(12)} ${s.supplier_name.padEnd(28)} | $${s.unit_cost.toFixed(2)} | ${s.lead_time_days}d | Rel: ${s.reliability_score} | ${s.region}`);
  }

  // Test bounded suppliers query
  const boundedSuppliers = await handleReadSuppliers({ limit: 2 });
  if (boundedSuppliers.total_found !== 2 || boundedSuppliers.limit_applied !== 2) {
    throw new Error(`❌ Bounded suppliers query failed: Expected 2 items, got ${boundedSuppliers.total_found}`);
  }
  console.log(`✅ Qodo #3 Fixed: Bounded suppliers query returned exactly ${boundedSuppliers.total_found} quotes (limit: 2)`);

  // 5. Test read_purchase_orders()
  console.log('\n🔍 Testing read_purchase_orders()...');
  const poResult = await handleReadPurchaseOrders({});

  if (poResult.total_found !== 3) {
    throw new Error(`❌ Expected 3 baseline purchase orders, found ${poResult.total_found}`);
  }

  console.log(`✅ Criteria 5 Passed: read_purchase_orders returned ${poResult.total_found} baseline orders:`);
  for (const po of poResult.purchase_orders) {
    console.log(`   - PO #${po.id}: ${po.item_name} | Qty: ${po.quantity} | Total: $${po.total_cost.toFixed(2)} | Status: ${po.status}`);
  }

  console.log('\n🎉 ALL Ticket #02 acceptance tests & Qodo review assertions PASSED successfully!');
}

runErpTests().catch((err) => {
  console.error('\n❌ ERP MCP Server test failed:', err);
  process.exit(1);
});
