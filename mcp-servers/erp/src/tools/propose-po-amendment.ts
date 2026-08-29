import { z } from 'zod';
import { getErpWriteDb } from '../db.js';

export const proposePoAmendmentSchema = {
  item_name: z
    .string()
    .min(1)
    .describe('Name of the item to order (e.g. "Marine Bearings, SKU-4471")'),
  supplier_id: z
    .number()
    .int()
    .positive()
    .describe('Target supplier ID for the amended order (e.g. 4 for IndoPacific Parts Corp)'),
  quantity: z
    .number()
    .int()
    .positive()
    .describe('Quantity of units to purchase'),
  notes: z
    .string()
    .optional()
    .describe('Operational justification or disruption triage notes for this amendment'),
};

export async function handleProposePoAmendment(params: {
  item_name: string;
  supplier_id: number;
  quantity: number;
  notes?: string;
}) {
  const db = await getErpWriteDb();

  // 1. Verify supplier existence and fetch unit cost
  const supplier = db
    .prepare('SELECT id, name, region, unit_cost FROM suppliers WHERE id = ?')
    .get(params.supplier_id) as any;

  if (!supplier) {
    throw new Error(
      `Supplier ID ${params.supplier_id} does not exist in ERP database.`
    );
  }

  // Check if supplier catalog has an item-specific quote for this item
  const catalogQuote = db
    .prepare(
      'SELECT unit_cost FROM supplier_catalog WHERE supplier_id = ? AND item_name = ?'
    )
    .get(params.supplier_id, params.item_name) as any;

  const unitCost = catalogQuote ? catalogQuote.unit_cost : supplier.unit_cost;
  const totalCost = Number((unitCost * params.quantity).toFixed(2));
  const defaultNotes =
    params.notes ??
    `Autonomous PO amendment approved via TrueForge gate. Replaced primary supplier due to regional disruption.`;

  // 2. Insert approved purchase order (this tool is gated by TrueForge; it only executes on user Allow)
  const insertSql = `
    INSERT INTO purchase_orders (item_name, supplier_id, quantity, unit_cost, total_cost, status, created_at, notes)
    VALUES (?, ?, ?, ?, ?, 'approved', CURRENT_TIMESTAMP, ?)
  `;

  const result = db
    .prepare(insertSql)
    .run(
      params.item_name,
      params.supplier_id,
      params.quantity,
      unitCost,
      totalCost,
      defaultNotes
    );

  const poId = Number(result.lastInsertRowid);

  // Fetch the inserted record
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
    status: 'approved',
    item_name: createdPo.item_name,
    supplier_id: createdPo.supplier_id,
    supplier_name: createdPo.supplier_name,
    supplier_region: createdPo.supplier_region,
    quantity: createdPo.quantity,
    unit_cost: createdPo.unit_cost,
    total_cost: createdPo.total_cost,
    created_at: createdPo.created_at,
    notes: createdPo.notes,
    message: `Purchase Order #${poId} committed with status 'approved' after human authorization.`,
  };
}
