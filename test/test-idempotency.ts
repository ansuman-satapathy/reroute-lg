import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set isolated test database path before loading db modules
const testDbPath = path.resolve(__dirname, '../data/test-erp-idempotency.db');
const masterDbPath = path.resolve(__dirname, '../data/erp.db');

process.env.DATABASE_PATH = testDbPath;

import { getErpDb, getErpWriteDb } from '../mcp-servers/erp/src/db.js';
import { handleProposePoAmendment } from '../mcp-servers/erp/src/tools/propose-po-amendment.js';

async function runIdempotencyTests() {
  console.log('🧪 Starting PO Idempotency & Stockout Boundary Verification (NFR-4 & FR-15)...');

  if (!fs.existsSync(masterDbPath)) {
    throw new Error(`Master database not found at ${masterDbPath}. Run 'npm run db:init' first.`);
  }

  // Create isolated copy for testing
  fs.copyFileSync(masterDbPath, testDbPath);

  try {
    const db = await getErpDb();
    const initialCount = (db.prepare('SELECT COUNT(*) as cnt FROM purchase_orders').get() as any).cnt;
    console.log(`📊 Baseline PO count: ${initialCount}`);

    // 1. First invocation: Valid PO amendment
    console.log('\n🔍 Test Step 1: Initial PO amendment invocation...');
    const firstCall = await handleProposePoAmendment({
      sku: 'SKU-4471',
      supplier_id: 4, // IndoPacific Parts Corp
      quantity: 200,
      notes: 'Initial emergency reorder due to typhoon disruption',
    });

    if (!firstCall.success || firstCall.duplicate) {
      throw new Error(`❌ Expected initial call to create fresh PO, got: ${JSON.stringify(firstCall)}`);
    }
    const createdPoId = firstCall.po_id;
    console.log(`✅ Initial PO created with ID #${createdPoId}, status='${firstCall.status}'`);

    const countAfterFirst = (db.prepare('SELECT COUNT(*) as cnt FROM purchase_orders').get() as any).cnt;
    if (countAfterFirst !== initialCount + 1) {
      throw new Error(`❌ Expected PO count to increase by 1 (${initialCount + 1}), got ${countAfterFirst}`);
    }

    // 2. Second invocation: Exact same SKU + supplier within 24 hours (NFR-4)
    console.log('\n🔍 Test Step 2: Second invocation with identical SKU + supplier within 24h...');
    const secondCall = await handleProposePoAmendment({
      sku: 'SKU-4471',
      supplier_id: 4,
      quantity: 200,
      notes: 'Duplicate retry attempt of emergency reorder',
    });

    if (!secondCall.success || !secondCall.duplicate) {
      throw new Error(`❌ Expected second call to return duplicate: true, got: ${JSON.stringify(secondCall)}`);
    }

    if (secondCall.po_id !== createdPoId) {
      throw new Error(`❌ Expected duplicate PO ID to match #${createdPoId}, got #${secondCall.po_id}`);
    }

    const countAfterSecond = (db.prepare('SELECT COUNT(*) as cnt FROM purchase_orders').get() as any).cnt;
    if (countAfterSecond !== countAfterFirst) {
      throw new Error(`❌ PO count changed on duplicate invocation! Expected ${countAfterFirst}, got ${countAfterSecond}`);
    }
    console.log(`✅ NFR-4 Passed: Duplicate call intercepted. Returned existing PO #${secondCall.po_id} with duplicate: true and unchanged row count (${countAfterSecond}).`);

    // 3. Test FR-15 Strict Stockout Boundary (lead_time_days >= daysOfSupply)
    console.log('\n🔍 Test Step 3: Verifying strict stockout boundary enforcement (FR-15)...');
    // Baltic Bearings (supplier 3) has lead_time_days = 28. Days of supply for SKU-4471 is 14.
    try {
      await handleProposePoAmendment({
        sku: 'SKU-4471',
        supplier_id: 3, // Baltic Bearings (lead time 28 days >= 14 days of supply)
        quantity: 200,
      });
      throw new Error('❌ Allowed PO amendment for supplier arriving after or on stockout day!');
    } catch (err: any) {
      if (err.message.includes('Guardrail Violation') && err.message.includes('Days of Supply')) {
        console.log(`✅ FR-15 Passed: Stockout boundary strictly enforced (${err.message.split('\n')[0]})`);
      } else {
        throw err;
      }
    }

    console.log('\n🎉 ALL NFR-4 Idempotency & FR-15 Boundary verification tests PASSED successfully!');
  } finally {
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
      console.log('🧹 Cleaned up isolated test database.');
    }
  }
}

runIdempotencyTests().catch((err) => {
  console.error('\n❌ Idempotency test failed:', err);
  process.exit(1);
});
