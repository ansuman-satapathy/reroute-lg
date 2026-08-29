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

  // 1. Verify item exists in inventory and fetch primary supplier & stock metrics
  const inventoryItem = db
    .prepare(
      `SELECT 
        i.id, 
        i.item_name, 
        i.sku, 
        i.current_stock, 
        i.daily_burn_rate,
        s.unit_cost as primary_unit_cost,
        s.name as primary_supplier_name,
        s.region as primary_supplier_region
      FROM inventory i
      JOIN suppliers s ON i.primary_supplier_id = s.id
      WHERE i.sku = ?`
    )
    .get(params.sku.trim()) as any;

  if (!inventoryItem) {
    throw new Error(
      `Item with SKU "${params.sku}" does not exist in inventory.`
    );
  }

  // 2. Verify supplier offering exists in catalog for this SKU
  const catalogQuote = db
    .prepare(
      `SELECT sc.unit_cost, sc.lead_time_days, sc.reliability_score, sc.item_name, 
              s.name as supplier_name, s.region as supplier_region
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

  // 3. Enforce Deterministic Operational Guardrails (Fix for Qodo #1)
  // Guardrail 1: Cost Band (Max +50% variance over primary unit cost)
  const maxCostCeiling = Number((inventoryItem.primary_unit_cost * 1.5).toFixed(2));
  if (catalogQuote.unit_cost > maxCostCeiling) {
    throw new Error(
      `Guardrail Violation: Alternate supplier unit cost ($${catalogQuote.unit_cost.toFixed(2)}) exceeds maximum acceptable cost band ceiling of +50% ($${maxCostCeiling.toFixed(2)}) over primary supplier (${inventoryItem.primary_supplier_name}: $${inventoryItem.primary_unit_cost.toFixed(2)}).`
    );
  }

  // Guardrail 2: Minimum Reliability Floor (>= 0.75)
  if (catalogQuote.reliability_score < 0.75) {
    throw new Error(
      `Guardrail Violation: Alternate supplier reliability score (${catalogQuote.reliability_score}) is below minimum acceptable floor of 0.75.`
    );
  }

  // Guardrail 3: Maximum Lead Time (<= 30 days)
  if (catalogQuote.lead_time_days > 30) {
    throw new Error(
      `Guardrail Violation: Alternate supplier lead time (${catalogQuote.lead_time_days} days) exceeds maximum allowable ceiling of 30 days.`
    );
  }

  // Guardrail 4: Arrival Before Projected Stockout Date (FR-15: lead_time_days < daysOfSupply)
  const daysOfSupply = Math.floor(inventoryItem.current_stock / (inventoryItem.daily_burn_rate || 1));
  if (catalogQuote.lead_time_days >= daysOfSupply) {
    throw new Error(
      `Guardrail Violation: Alternate supplier lead time (${catalogQuote.lead_time_days} days) exceeds available Days of Supply (${daysOfSupply} days at ${inventoryItem.daily_burn_rate} units/day). Alternate delivery must arrive strictly before stockout day!`
    );
  }

  const resolvedItemName = params.item_name?.trim() || catalogQuote.item_name || inventoryItem.item_name;
  const unitCost = catalogQuote.unit_cost;
  const totalCost = Number((unitCost * params.quantity).toFixed(2));
  const defaultNotes =
    params.notes ??
    `Autonomous PO amendment approved via TrueForge gate. Replaced primary supplier due to regional disruption.`;

  // Idempotency: detect duplicate PO within last 24 hours for same canonical SKU + supplier
  const canonicalSku = params.sku.trim();
  const recentPo = db
    .prepare(
      `SELECT id, sku, item_name, supplier_id, quantity, unit_cost, total_cost, status, created_at, notes
       FROM purchase_orders
       WHERE supplier_id = ? AND sku = ?
         AND created_at >= datetime('now', '-24 hours')
         AND status IN ('approved', 'pending')
       ORDER BY id DESC LIMIT 1`
    )
    .get(params.supplier_id, canonicalSku) as any;

  if (recentPo) {
    return {
      success: true,
      po_id: Number(recentPo.id),
      status: recentPo.status,
      duplicate: true,
      sku: recentPo.sku || canonicalSku,
      item_name: recentPo.item_name,
      supplier_id: recentPo.supplier_id,
      supplier_name: catalogQuote.supplier_name,
      supplier_region: catalogQuote.supplier_region,
      quantity: recentPo.quantity,
      unit_cost: recentPo.unit_cost,
      total_cost: recentPo.total_cost,
      notes: recentPo.notes,
      message: `Idempotency: Purchase Order #${recentPo.id} already exists for SKU "${canonicalSku}" with supplier ${params.supplier_id} (created within last 24h). Existing order preserved without duplication.`,
    };
  }

  // 3. Insert approved purchase order (gated by TrueForge; only executes on user Allow)
  const insertSql = `
    INSERT INTO purchase_orders (sku, item_name, supplier_id, quantity, unit_cost, total_cost, status, created_at, notes)
    VALUES (?, ?, ?, ?, ?, ?, 'approved', CURRENT_TIMESTAMP, ?)
  `;

  const result = db
    .prepare(insertSql)
    .run(
      canonicalSku,
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
