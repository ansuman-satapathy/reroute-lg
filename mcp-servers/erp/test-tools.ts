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

  // 2. Test read_inventory({ sku: "SKU-4471" })
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

  // Also test unbounded inventory lookup
  const allInventory = await handleReadInventory({});
  if (allInventory.total_found !== 13) {
    throw new Error(`❌ Expected 13 total inventory items, found ${allInventory.total_found}`);
  }
  console.log(`   - Total inventory items queried: ${allInventory.total_found}`);

  // 3. Test read_suppliers({ sku: "SKU-4471" })
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

  // Test region filter (e.g. "East China Sea")
  const regionSuppliers = await handleReadSuppliers({ region: 'East China Sea' });
  if (regionSuppliers.total_found === 0) {
    throw new Error('❌ Regional filter query returned 0 suppliers');
  }
  console.log(`   - Regional query ('East China Sea') returned ${regionSuppliers.total_found} supplier(s)`);

  // 4. Test read_purchase_orders()
  console.log('\n🔍 Testing read_purchase_orders()...');
  const poResult = await handleReadPurchaseOrders({});

  if (poResult.total_found !== 3) {
    throw new Error(`❌ Expected 3 baseline purchase orders, found ${poResult.total_found}`);
  }

  console.log(`✅ Criteria 5 Passed: read_purchase_orders returned ${poResult.total_found} baseline orders:`);
  for (const po of poResult.purchase_orders) {
    console.log(`   - PO #${po.id}: ${po.item_name} | Qty: ${po.quantity} | Total: $${po.total_cost.toFixed(2)} | Status: ${po.status}`);
  }

  console.log('\n🎉 ALL Ticket #02 acceptance tests PASSED successfully!');
}

runErpTests().catch((err) => {
  console.error('\n❌ ERP MCP Server test failed:', err);
  process.exit(1);
});
