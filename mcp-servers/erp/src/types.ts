/**
 * ERP MCP Server - Core Domain Types
 */

export interface InventoryRecord {
  id: number;
  item_name: string;
  sku: string;
  current_stock: number;
  reorder_threshold: number;
  daily_burn_rate: number;
  days_of_supply: number;
  primary_supplier_id: number;
  primary_supplier_name: string;
  primary_supplier_region: string;
  primary_supplier_port: string;
  is_reorder_needed: boolean;
}

export interface SupplierRecord {
  supplier_id: number;
  supplier_name: string;
  region: string;
  port_of_origin: string;
  sku: string;
  item_name: string;
  unit_cost: number;
  lead_time_days: number;
  reliability_score: number;
  is_primary: boolean;
}

export interface PurchaseOrderRecord {
  id: number;
  item_name: string;
  supplier_id: number;
  supplier_name: string;
  supplier_region: string;
  quantity: number;
  unit_cost: number;
  total_cost: number;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  notes: string | null;
}
