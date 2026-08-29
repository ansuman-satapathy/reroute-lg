import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { getDatabase, resolveDatabasePath } from './init-db.js';

const __filename = fileURLToPath(import.meta.url);

export async function verifyDatabase() {
  const dbPath = resolveDatabasePath();
  console.log('🔍 Verifying ERP Database at:', dbPath);
  const db = await getDatabase(dbPath);

  try {
    // 1. Verify Primary Supplier for SKU-4471
    const primarySupplierQuery = `
      SELECT s.*, i.item_name, i.current_stock, i.reorder_threshold
      FROM inventory i
      JOIN suppliers s ON i.primary_supplier_id = s.id
      WHERE i.sku = 'SKU-4471'
    `;
    const primary = db.prepare(primarySupplierQuery).get() as any;

    if (!primary) {
      throw new Error('❌ Verification failed: SKU-4471 or its primary supplier not found!');
    }
    if (primary.region !== 'East China Sea') {
      throw new Error(`❌ Verification failed: Expected region 'East China Sea', got '${primary.region}'`);
    }
    if (primary.name !== 'Oceanic Bearings Ltd') {
      throw new Error(`❌ Verification failed: Expected supplier 'Oceanic Bearings Ltd', got '${primary.name}'`);
    }
    console.log('✅ Criteria 1 Passed: Primary supplier for SKU-4471 is Oceanic Bearings Ltd in East China Sea.');
    console.log(`   Stock: ${primary.current_stock}/${primary.reorder_threshold} (Stockout alert imminent)`);

    // 2. Verify Alternate Suppliers for SKU-4471 (Ensuring distinct expected IDs: 2, 3, 4)
    const alternatesQuery = `
      SELECT s.id as supplier_id, s.name, s.region, sc.unit_cost, sc.lead_time_days, sc.reliability_score
      FROM supplier_catalog sc
      JOIN suppliers s ON sc.supplier_id = s.id
      WHERE sc.sku = 'SKU-4471' AND s.id != 1
      ORDER BY sc.unit_cost ASC
    `;
    const alternates = db.prepare(alternatesQuery).all() as any[];
    const alternateIds = new Set(alternates.map((a) => a.supplier_id));
    const expectedIds = [2, 3, 4];

    if (alternates.length !== 3 || alternateIds.size !== 3) {
      throw new Error(
        `❌ Verification failed: Expected 3 distinct alternate suppliers, found ${alternates.length} rows (${alternateIds.size} distinct)`
      );
    }

    for (const expectedId of expectedIds) {
      if (!alternateIds.has(expectedId)) {
        throw new Error(`❌ Verification failed: Expected alternate supplier ID ${expectedId} not found in catalog`);
      }
    }

    console.log('✅ Criteria 2 Passed: Found 3 distinct alternate suppliers (IDs 2, 3, 4) with differentiated trade-offs:');
    for (const alt of alternates) {
      console.log(
        `   - [ID ${alt.supplier_id}] ${alt.name.padEnd(28)} | $${alt.unit_cost.toFixed(2)}/unit | Lead: ${alt.lead_time_days.toString().padStart(2)}d | Rel: ${alt.reliability_score}`
      );
    }

    // Sanity check trade-off profile invariants:
    // Cheapest must be slow (> 20 days)
    const cheapest = alternates[0];
    if (cheapest.unit_cost >= primary.unit_cost || cheapest.lead_time_days < 20) {
      throw new Error('❌ Cheap-but-slow supplier does not have expected trade-off profile');
    }
    // Fastest must have lead time < 10 days
    const fastest = alternates.find((a) => a.lead_time_days < 10);
    if (!fastest || fastest.unit_cost <= primary.unit_cost) {
      throw new Error('❌ Fast-but-pricey supplier does not have expected trade-off profile');
    }
    // Balanced must have moderate cost and lead time
    const balanced = alternates.find((a) => a.lead_time_days > 10 && a.lead_time_days < 20);
    if (!balanced) {
      throw new Error('❌ Balanced supplier not found');
    }

    // 3. Verify CHECK constraint on purchase_orders status (Fixing self-catching assertion bug)
    console.log('✅ Testing purchase_orders status CHECK constraint...');
    let constraintEnforced = false;
    try {
      db.prepare(`
        INSERT INTO purchase_orders (item_name, supplier_id, quantity, unit_cost, total_cost, status)
        VALUES ('Test Item', 1, 10, 10.0, 100.0, 'invalid_status')
      `).run();
    } catch (err: any) {
      if (err.message.includes('CHECK constraint failed') || err.message.includes('check constraint')) {
        constraintEnforced = true;
      } else {
        throw err;
      }
    }

    if (!constraintEnforced) {
      // In case an invalid status was erroneously accepted, clean it up before throwing
      try {
        db.prepare(`DELETE FROM purchase_orders WHERE status = 'invalid_status'`).run();
      } catch {}
      throw new Error('❌ CHECK constraint verification failed: Table allowed invalid status insert!');
    }
    console.log('✅ Criteria 3 Passed: CHECK constraint on purchase_orders status enforced successfully.');

    // 4. Assert Expected Table Counts (Exact counts for suppliers, inventory, baseline POs)
    const supplierCount = (db.prepare('SELECT COUNT(*) as count FROM suppliers').get() as any).count;
    const inventoryCount = (db.prepare('SELECT COUNT(*) as count FROM inventory').get() as any).count;
    const poCount = (db.prepare('SELECT COUNT(*) as count FROM purchase_orders').get() as any).count;

    if (supplierCount !== 16) {
      throw new Error(`❌ Count assertion failed: Expected 16 suppliers, got ${supplierCount}`);
    }
    if (inventoryCount !== 13) {
      throw new Error(`❌ Count assertion failed: Expected 13 inventory items, got ${inventoryCount}`);
    }
    if (poCount !== 3) {
      throw new Error(`❌ Count assertion failed: Expected 3 baseline purchase orders, got ${poCount}`);
    }

    console.log(`✅ Table Counts Verified: Exactly ${supplierCount} suppliers, ${inventoryCount} inventory items, and ${poCount} baseline POs.`);
    console.log('🎉 All Ticket #01 verification checks PASSED!');
  } finally {
    db.close();
  }
}

if (process.argv[1] === __filename) {
  verifyDatabase().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
