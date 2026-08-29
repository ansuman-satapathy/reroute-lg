-- ===================================================
-- Logistics Disruption Triage - ERP SQLite Schema (FR-4)
-- ===================================================

PRAGMA foreign_keys = ON;

-- 1. Suppliers Table
CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    region TEXT NOT NULL,
    port_of_origin TEXT NOT NULL,
    reliability_score REAL NOT NULL CHECK(reliability_score >= 0.0 AND reliability_score <= 1.0),
    lead_time_days INTEGER NOT NULL CHECK(lead_time_days > 0),
    unit_cost REAL NOT NULL CHECK(unit_cost > 0)
);

-- Index on region for disruption impact queries
CREATE INDEX IF NOT EXISTS idx_suppliers_region ON suppliers(region);

-- 2. Inventory Table
CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_name TEXT NOT NULL,
    sku TEXT NOT NULL UNIQUE,
    current_stock INTEGER NOT NULL CHECK(current_stock >= 0),
    reorder_threshold INTEGER NOT NULL CHECK(reorder_threshold >= 0),
    daily_burn_rate INTEGER NOT NULL DEFAULT 10 CHECK(daily_burn_rate > 0),
    primary_supplier_id INTEGER NOT NULL,
    FOREIGN KEY (primary_supplier_id) REFERENCES suppliers(id)
);

-- Index on primary_supplier_id to quickly locate affected items during disruption
CREATE INDEX IF NOT EXISTS idx_inventory_supplier ON inventory(primary_supplier_id);
CREATE INDEX IF NOT EXISTS idx_inventory_sku ON inventory(sku);

-- 3. Supplier Alternate Offerings (Associates alternate suppliers to items/SKUs)
CREATE TABLE IF NOT EXISTS supplier_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL,
    sku TEXT NOT NULL,
    item_name TEXT NOT NULL,
    unit_cost REAL NOT NULL CHECK(unit_cost > 0),
    lead_time_days INTEGER NOT NULL CHECK(lead_time_days > 0),
    reliability_score REAL NOT NULL CHECK(reliability_score >= 0.0 AND reliability_score <= 1.0),
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
    FOREIGN KEY (sku) REFERENCES inventory(sku),
    UNIQUE(supplier_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_catalog_sku ON supplier_catalog(sku);

-- 4. Purchase Orders Table (FR-4, FR-11, FR-11a)
-- Only purchase_orders is ever mutated during the triage & approval lifecycle
CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL,
    item_name TEXT NOT NULL,
    supplier_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    unit_cost REAL NOT NULL CHECK(unit_cost > 0),
    total_cost REAL NOT NULL CHECK(total_cost > 0),
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

CREATE INDEX IF NOT EXISTS idx_po_sku ON purchase_orders(sku);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
