import { z } from 'zod';
import { getErpWriteDb } from '../db.js';

export const proposePoAmendmentSchema = {
  sku: z
    .string()
    .min(1)
    .describe('Canonical SKU of the item to order (e.g. "SKU-4471")'),
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
  item_name: z
    .string()
    .optional()
    .describe('Optional descriptive name of the item (defaults to canonical inventory item name)'),
  notes: z
    .string()
    .optional()
    .describe('Operational justification or disruption triage notes for this amendment'),
};

export async function handleProposePoAmendment(params: {
  sku: string;
  supplier_id: number;
  quantity: number;
  item_name?: string;
  notes?: string;
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
      `Supplier ID ${params.supplier_id} does not have a registered offering for SKU "${params.sku}". Only verified catalog offerings may be amended.`
    );
  }

  const resolvedItemName = params.item_name?.trim() || catalogQuote.item_name || inventoryItem.item_name;
  const unitCost = catalogQuote.unit_cost;
  const totalCost = Number((unitCost * params.quantity).toFixed(2));
  const defaultNotes =
    params.notes ??
    `Autonomous PO amendment approved via TrueForge gate. Replaced primary supplier due to regional disruption.`;

  // 3. Insert approved purchase order (gated by TrueForge; only executes on user Allow)
  const insertSql = `
    INSERT INTO purchase_orders (item_name, supplier_id, quantity, unit_cost, total_cost, status, created_at, notes)
    VALUES (?, ?, ?, ?, ?, 'approved', CURRENT_TIMESTAMP, ?)
  `;

  const result = db
    .prepare(insertSql)
    .run(
      resolvedItemName,
      params.supplier_id,
      params.quantity,
      unitCost,
      totalCost,
      defaultNotes
    );

  const poId = Number(result.lastInsertRowid);

  return {
    success: true,
    po_id: poId,
    status: 'approved',
    sku: params.sku,
    item_name: resolvedItemName,
    supplier_id: params.supplier_id,
    supplier_name: catalogQuote.supplier_name,
    supplier_region: catalogQuote.supplier_region,
    quantity: params.quantity,
    unit_cost: unitCost,
    total_cost: totalCost,
    notes: defaultNotes,
    message: `Purchase Order #${poId} committed with status 'approved' after human authorization.`,
  };
}
