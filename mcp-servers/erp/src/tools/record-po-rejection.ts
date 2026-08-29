import { z } from 'zod';
import { getErpWriteDb } from '../db.js';

export const recordPoRejectionSchema = {
  sku: z
    .string()
    .min(1)
    .describe('Canonical SKU of the item that was rejected (e.g. "SKU-4471")'),
  supplier_id: z
    .number()
    .int()
    .positive()
    .describe('Supplier ID of the rejected proposal'),
  quantity: z
    .number()
    .int()
    .positive()
    .describe('Quantity of units that were proposed'),
  reason: z
    .string()
    .min(1)
    .describe('Reason for rejection provided by the human operator'),
  item_name: z
    .string()
    .optional()
    .describe('Optional descriptive name of the item'),
};

export async function handleRecordPoRejection(params: {
  sku: string;
  supplier_id: number;
  quantity: number;
  reason: string;
  item_name?: string;
}) {
  const db = await getErpWriteDb();

  // 1. Verify item exists in inventory
  const inventoryItem = db
    .prepare('SELECT id, item_name, sku FROM inventory WHERE sku = ?')
    .get(params.sku.trim()) as any;

  if (!inventoryItem) {
    throw new Error(
      `Item with SKU "${params.sku}" does not exist in inventory.`
    );
  }

  // 2. Verify supplier offering exists in catalog for this SKU
  const catalogQuote = db
    .prepare(
      `SELECT sc.unit_cost, sc.item_name, s.name as supplier_name, s.region as supplier_region
       FROM supplier_catalog sc
       JOIN suppliers s ON sc.supplier_id = s.id
       WHERE sc.supplier_id = ? AND sc.sku = ?`
    )
    .get(params.supplier_id, params.sku.trim()) as any;

  if (!catalogQuote) {
    throw new Error(
      `Supplier ID ${params.supplier_id} does not have a registered offering for SKU "${params.sku}". Only verified catalog offerings may be recorded.`
    );
  }

  const resolvedItemName = params.item_name?.trim() || catalogQuote.item_name || inventoryItem.item_name;
  const unitCost = catalogQuote.unit_cost;
  const totalCost = Number((unitCost * params.quantity).toFixed(2));
  const auditNotes = `REJECTED BY OPERATOR: ${params.reason.trim()}`;

  const insertSql = `
    INSERT INTO purchase_orders (item_name, supplier_id, quantity, unit_cost, total_cost, status, created_at, notes)
    VALUES (?, ?, ?, ?, ?, 'rejected', CURRENT_TIMESTAMP, ?)
  `;

  const result = db
    .prepare(insertSql)
    .run(
      resolvedItemName,
      params.supplier_id,
      params.quantity,
      unitCost,
      totalCost,
      auditNotes
    );

  const poId = Number(result.lastInsertRowid);

  return {
    success: true,
    po_id: poId,
    status: 'rejected',
    sku: params.sku,
    item_name: resolvedItemName,
    supplier_id: params.supplier_id,
    supplier_name: catalogQuote.supplier_name,
    supplier_region: catalogQuote.supplier_region,
    quantity: params.quantity,
    unit_cost: unitCost,
    total_cost: totalCost,
    rejection_reason: params.reason,
    notes: auditNotes,
    message: `Purchase Order rejection audit record #${poId} logged with status 'rejected'.`,
  };
}
