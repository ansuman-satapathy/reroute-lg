import { z } from 'zod';
import { getErpWriteDb } from '../db.js';

export const recordPoRejectionSchema = {
  item_name: z
    .string()
    .min(1)
    .describe('Name of the item for the rejected proposal'),
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
};

export async function handleRecordPoRejection(params: {
  item_name: string;
  supplier_id: number;
  quantity: number;
  reason: string;
}) {
  const db = await getErpWriteDb();

  const supplier = db
    .prepare('SELECT id, name, region, unit_cost FROM suppliers WHERE id = ?')
    .get(params.supplier_id) as any;

  if (!supplier) {
    throw new Error(
      `Supplier ID ${params.supplier_id} does not exist in ERP database.`
    );
  }

  const catalogQuote = db
    .prepare(
      'SELECT unit_cost FROM supplier_catalog WHERE supplier_id = ? AND item_name = ?'
    )
    .get(params.supplier_id, params.item_name) as any;

  const unitCost = catalogQuote ? catalogQuote.unit_cost : supplier.unit_cost;
  const totalCost = Number((unitCost * params.quantity).toFixed(2));
  const auditNotes = `REJECTED BY OPERATOR: ${params.reason.trim()}`;

  const insertSql = `
    INSERT INTO purchase_orders (item_name, supplier_id, quantity, unit_cost, total_cost, status, created_at, notes)
    VALUES (?, ?, ?, ?, ?, 'rejected', CURRENT_TIMESTAMP, ?)
  `;

  const result = db
    .prepare(insertSql)
    .run(
      params.item_name,
      params.supplier_id,
      params.quantity,
      unitCost,
      totalCost,
      auditNotes
    );

  const poId = Number(result.lastInsertRowid);

  const createdPo = db
    .prepare(
      `SELECT po.*, s.name as supplier_name, s.region as supplier_region
       FROM purchase_orders po
       JOIN suppliers s ON po.supplier_id = s.id
       WHERE po.id = ?`
    )
    .get(poId) as any;

  return {
    success: true,
    po_id: poId,
    status: 'rejected',
    item_name: createdPo.item_name,
    supplier_id: createdPo.supplier_id,
    supplier_name: createdPo.supplier_name,
    supplier_region: createdPo.supplier_region,
    quantity: createdPo.quantity,
    unit_cost: createdPo.unit_cost,
    total_cost: createdPo.total_cost,
    rejection_reason: params.reason,
    created_at: createdPo.created_at,
    notes: createdPo.notes,
    message: `Purchase Order rejection audit record #${poId} logged with status 'rejected'.`,
  };
}
