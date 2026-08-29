import { z } from 'zod';
import { getErpDb } from '../db.js';
import type { InventoryRecord } from '../types.js';

export const readInventorySchema = {
  sku: z
    .string()
    .optional()
    .describe('Filter inventory by specific SKU (e.g. "SKU-4471")'),
  item_name: z
    .string()
    .optional()
    .describe('Filter inventory by item name substring (e.g. "Bearings")'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .default(50)
    .describe('Maximum number of items to return (default: 50)'),
};

export async function handleReadInventory(params: {
  sku?: string;
  item_name?: string;
  limit?: number;
}) {
  const db = await getErpDb();
  const limit = params.limit ?? 50;

  let query = `
    SELECT 
      i.id,
      i.item_name,
      i.sku,
      i.current_stock,
      i.reorder_threshold,
      i.daily_burn_rate,
      i.primary_supplier_id,
      s.name as primary_supplier_name,
      s.region as primary_supplier_region,
      s.port_of_origin as primary_supplier_port,
      (i.current_stock <= i.reorder_threshold) as is_reorder_needed
    FROM inventory i
    JOIN suppliers s ON i.primary_supplier_id = s.id
    WHERE 1=1
  `;

  const queryParams: any[] = [];

  if (params.sku) {
    query += ` AND i.sku = ?`;
    queryParams.push(params.sku.trim());
  }

  if (params.item_name) {
    query += ` AND i.item_name LIKE ?`;
    queryParams.push(`%${params.item_name.trim()}%`);
  }

  query += ` ORDER BY i.id ASC LIMIT ?`;
  queryParams.push(limit);

  const rows = db.prepare(query).all(...queryParams) as any[];

  const inventory: InventoryRecord[] = rows.map((r) => ({
    id: r.id,
    item_name: r.item_name,
    sku: r.sku,
    current_stock: r.current_stock,
    reorder_threshold: r.reorder_threshold,
    daily_burn_rate: r.daily_burn_rate,
    days_of_supply: Math.floor(r.current_stock / (r.daily_burn_rate || 1)),
    primary_supplier_id: r.primary_supplier_id,
    primary_supplier_name: r.primary_supplier_name,
    primary_supplier_region: r.primary_supplier_region,
    primary_supplier_port: r.primary_supplier_port,
    is_reorder_needed: Boolean(r.is_reorder_needed),
  }));

  return {
    total_found: inventory.length,
    limit_applied: limit,
    inventory,
  };
}
