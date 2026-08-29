import { z } from 'zod';
import { getErpDb } from '../db.js';
import type { PurchaseOrderRecord } from '../types.js';

export const readPurchaseOrdersSchema = {
  status: z
    .enum(['pending', 'approved', 'rejected'])
    .optional()
    .describe('Filter by purchase order status ("pending", "approved", or "rejected")'),
  item_name: z
    .string()
    .optional()
    .describe('Filter by item name substring (e.g. "Marine Bearings")'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .default(50)
    .describe('Maximum number of orders to return (default: 50)'),
};

export async function handleReadPurchaseOrders(params: {
  status?: 'pending' | 'approved' | 'rejected';
  item_name?: string;
  limit?: number;
}) {
  const db = await getErpDb();
  const limit = params.limit ?? 50;

  let query = `
    SELECT 
      po.id,
      po.item_name,
      po.supplier_id,
      s.name as supplier_name,
      s.region as supplier_region,
      po.quantity,
      po.unit_cost,
      po.total_cost,
      po.status,
      po.created_at,
      po.notes
    FROM purchase_orders po
    JOIN suppliers s ON po.supplier_id = s.id
    WHERE 1=1
  `;

  const queryParams: any[] = [];

  if (params.status) {
    query += ` AND po.status = ?`;
    queryParams.push(params.status);
  }

  if (params.item_name) {
    query += ` AND po.item_name LIKE ?`;
    queryParams.push(`%${params.item_name.trim()}%`);
  }

  query += ` ORDER BY po.created_at DESC LIMIT ?`;
  queryParams.push(limit);

  const rows = db.prepare(query).all(...queryParams) as any[];

  const purchaseOrders: PurchaseOrderRecord[] = rows.map((r) => ({
    id: r.id,
    item_name: r.item_name,
    supplier_id: r.supplier_id,
    supplier_name: r.supplier_name,
    supplier_region: r.supplier_region,
    quantity: r.quantity,
    unit_cost: r.unit_cost,
    total_cost: r.total_cost,
    status: r.status,
    created_at: r.created_at,
    notes: r.notes ?? null,
  }));

  return {
    total_found: purchaseOrders.length,
    purchase_orders: purchaseOrders,
  };
}
