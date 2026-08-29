import { z } from 'zod';
import { getErpDb } from '../db.js';
import type { SupplierRecord } from '../types.js';

export const readSuppliersSchema = {
  sku: z
    .string()
    .optional()
    .describe('Filter supplier offerings by item SKU (e.g. "SKU-4471")'),
  region: z
    .string()
    .optional()
    .describe('Filter suppliers by geographical region (e.g. "East China Sea", "South Korea")'),
  item_name: z
    .string()
    .optional()
    .describe('Filter suppliers by item name substring (e.g. "Marine Bearings")'),
};

export async function handleReadSuppliers(params: {
  sku?: string;
  region?: string;
  item_name?: string;
}) {
  const db = await getErpDb();

  let query = `
    SELECT 
      s.id as supplier_id,
      s.name as supplier_name,
      s.region,
      s.port_of_origin,
      sc.sku,
      sc.item_name,
      sc.unit_cost,
      sc.lead_time_days,
      sc.reliability_score,
      (i.primary_supplier_id = s.id) as is_primary
    FROM supplier_catalog sc
    JOIN suppliers s ON sc.supplier_id = s.id
    LEFT JOIN inventory i ON i.sku = sc.sku
    WHERE 1=1
  `;

  const queryParams: any[] = [];

  if (params.sku) {
    query += ` AND sc.sku = ?`;
    queryParams.push(params.sku.trim());
  }

  if (params.region) {
    query += ` AND s.region LIKE ?`;
    queryParams.push(`%${params.region.trim()}%`);
  }

  if (params.item_name) {
    query += ` AND sc.item_name LIKE ?`;
    queryParams.push(`%${params.item_name.trim()}%`);
  }

  query += ` ORDER BY sc.sku, sc.unit_cost ASC`;

  const rows = db.prepare(query).all(...queryParams) as any[];

  const suppliers: SupplierRecord[] = rows.map((r) => ({
    supplier_id: r.supplier_id,
    supplier_name: r.supplier_name,
    region: r.region,
    port_of_origin: r.port_of_origin,
    sku: r.sku,
    item_name: r.item_name,
    unit_cost: r.unit_cost,
    lead_time_days: r.lead_time_days,
    reliability_score: r.reliability_score,
    is_primary: Boolean(r.is_primary),
  }));

  return {
    total_found: suppliers.length,
    suppliers,
  };
}
