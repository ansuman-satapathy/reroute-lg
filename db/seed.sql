-- ===================================================
-- Logistics Disruption Triage - Core Scenario Seed Data (FR-5)
-- ===================================================

-- Clear existing data for clean idempotent seeding
DELETE FROM purchase_orders;
DELETE FROM supplier_catalog;
DELETE FROM inventory;
DELETE FROM suppliers;

-- ---------------------------------------------------
-- 1. Suppliers
-- ---------------------------------------------------
-- Core Scenario Suppliers (IDs 1-4)
INSERT INTO suppliers (id, name, region, port_of_origin, reliability_score, lead_time_days, unit_cost) VALUES
(1, 'Oceanic Bearings Ltd', 'East China Sea', 'Port of Ningbo-Zhoushan', 0.94, 14, 42.50),  -- Primary supplier (in disruption zone)
(2, 'Pacific Marine Supply', 'South Korea', 'Port of Busan', 0.82, 7, 62.00),              -- Alternate: Fast-but-pricier
(3, 'Baltic Precision Components', 'Northern Europe', 'Port of Hamburg', 0.96, 28, 38.00), -- Alternate: Cheap-but-slow
(4, 'IndoPacific Parts Corp', 'Southeast Asia', 'Port of Singapore', 0.89, 12, 47.50);     -- Alternate: Balanced trade-off

-- Filler Suppliers (IDs 5-16, realistic industrial marine suppliers)
INSERT INTO suppliers (id, name, region, port_of_origin, reliability_score, lead_time_days, unit_cost) VALUES
(5, 'Nippon Hydraulics Marine', 'Sea of Japan', 'Port of Kobe', 0.95, 10, 115.00),
(6, 'Hanseatic Diesel Systems', 'Northern Europe', 'Port of Bremen', 0.97, 18, 480.00),
(7, 'Daewoo Marine Forging', 'South Korea', 'Port of Ulsan', 0.91, 16, 230.00),
(8, 'Helvetia Turbo Solutions', 'Central Europe', 'Port of Rotterdam', 0.98, 22, 1450.00),
(9, 'Kanto Maritime Electronics', 'Sea of Japan', 'Port of Yokohama', 0.93, 9, 890.00),
(10, 'Seto Inland Bronze Foundry', 'Sea of Japan', 'Port of Osaka', 0.92, 25, 2100.00),
(11, 'Nordic Deck Machinery AB', 'Scandinavia', 'Port of Gothenburg', 0.94, 15, 620.00),
(12, 'SingaPure Membrane Tech', 'Southeast Asia', 'Port of Singapore', 0.90, 8, 175.00),
(13, 'St. Lawrence Polymer Bushings', 'North America East', 'Port of Montreal', 0.96, 20, 88.00),
(14, 'Jutland Marine Actuators', 'Scandinavia', 'Port of Aarhus', 0.95, 14, 340.00),
(15, 'Skagerrak Centrifuge Spares', 'Scandinavia', 'Port of Malmo', 0.93, 11, 295.00),
(16, 'Fjordland Sensorics AS', 'Scandinavia', 'Port of Bergen', 0.97, 13, 510.00);

-- ---------------------------------------------------
-- 2. Inventory Items
-- ---------------------------------------------------
-- Core Scenario Item: Marine Bearings (SKU-4471)
-- Stock is below reorder threshold (140 vs 300), creating urgent operational necessity
INSERT INTO inventory (id, item_name, sku, current_stock, reorder_threshold, daily_burn_rate, primary_supplier_id) VALUES
(1, 'Marine Bearings, SKU-4471', 'SKU-4471', 140, 300, 10, 1);

-- Filler Inventory Items (IDs 2-13, never modified during demo)
INSERT INTO inventory (id, item_name, sku, current_stock, reorder_threshold, daily_burn_rate, primary_supplier_id) VALUES
(2, 'High-Pressure Hydraulic Seal Kit', 'SKU-1012', 450, 200, 15, 5),
(3, 'Common Rail Diesel Injectors (Tier III)', 'SKU-2045', 85, 50, 5, 6),
(4, 'High-Tensile Studded Anchor Chain 32mm', 'SKU-3190', 60, 40, 4, 7),
(5, 'Marine Turbocharger Compressor Wheel', 'SKU-5502', 25, 15, 2, 8),
(6, 'X-Band Solid-State Radar Transceiver', 'SKU-6211', 18, 10, 1, 9),
(7, 'Ni-Al Bronze Controllable Pitch Blade', 'SKU-7084', 12, 8, 1, 10),
(8, 'Electro-Hydraulic Cargo Winch Directional Valve', 'SKU-8123', 90, 60, 6, 11),
(9, 'SWRO Desalination Spiral Membrane Element', 'SKU-9005', 210, 150, 10, 12),
(10, 'Composite Water-Lubricated Rudder Bushing', 'SKU-4480', 75, 45, 5, 13),
(11, 'Fail-Safe Emergency Bilge Valve Actuator', 'SKU-3341', 34, 25, 3, 14),
(12, 'HFO Purifier Centrifuge Disc Stack Set', 'SKU-6612', 55, 30, 4, 15),
(13, 'Optical Bilge Water Oil Content Detector', 'SKU-7729', 40, 20, 2, 16);

-- ---------------------------------------------------
-- 3. Supplier Catalog (Alternate supplier quotes for SKU-4471)
-- ---------------------------------------------------
-- All 4 suppliers quoting for SKU-4471 to demonstrate non-trivial multi-criteria trade-offs
INSERT INTO supplier_catalog (supplier_id, sku, item_name, unit_cost, lead_time_days, reliability_score) VALUES
(1, 'SKU-4471', 'Marine Bearings, SKU-4471', 42.50, 14, 0.94),  -- Primary (Disrupted region)
(2, 'SKU-4471', 'Marine Bearings, SKU-4471', 62.00, 7, 0.82),   -- Fast (+45.8% cost, 7 days, 0.82 rel)
(3, 'SKU-4471', 'Marine Bearings, SKU-4471', 38.00, 28, 0.96),  -- Cheap ($38.00, but 28 days delay)
(4, 'SKU-4471', 'Marine Bearings, SKU-4471', 47.50, 12, 0.89);  -- Balanced ($47.50, 12 days, 0.89 rel)

-- Catalog entries for other items (primary quotes)
INSERT INTO supplier_catalog (supplier_id, sku, item_name, unit_cost, lead_time_days, reliability_score) VALUES
(5, 'SKU-1012', 'High-Pressure Hydraulic Seal Kit', 115.00, 10, 0.95),
(6, 'SKU-2045', 'Common Rail Diesel Injectors (Tier III)', 480.00, 18, 0.97),
(7, 'SKU-3190', 'High-Tensile Studded Anchor Chain 32mm', 230.00, 16, 0.91),
(8, 'SKU-5502', 'Marine Turbocharger Compressor Wheel', 1450.00, 22, 0.98),
(9, 'SKU-6211', 'X-Band Solid-State Radar Transceiver', 890.00, 9, 0.93),
(10, 'SKU-7084', 'Ni-Al Bronze Controllable Pitch Blade', 2100.00, 25, 0.92),
(11, 'SKU-8123', 'Electro-Hydraulic Cargo Winch Directional Valve', 620.00, 15, 0.94),
(12, 'SKU-9005', 'SWRO Desalination Spiral Membrane Element', 175.00, 8, 0.90),
(13, 'SKU-4480', 'Composite Water-Lubricated Rudder Bushing', 88.00, 20, 0.96),
(14, 'SKU-3341', 'Fail-Safe Emergency Bilge Valve Actuator', 340.00, 14, 0.95),
(15, 'SKU-6612', 'HFO Purifier Centrifuge Disc Stack Set', 295.00, 11, 0.93),
(16, 'SKU-7729', 'Optical Bilge Water Oil Content Detector', 510.00, 13, 0.97);

-- ---------------------------------------------------
-- 4. Initial Baseline Purchase Orders
-- ---------------------------------------------------
-- Historic baseline orders for realism; none in pending status
INSERT INTO purchase_orders (id, sku, item_name, supplier_id, quantity, unit_cost, total_cost, status, created_at, notes) VALUES
(101, 'SKU-1012', 'High-Pressure Hydraulic Seal Kit', 5, 100, 115.00, 11500.00, 'approved', '2026-08-01 10:00:00', 'Quarterly scheduled restock'),
(102, 'SKU-2045', 'Common Rail Diesel Injectors (Tier III)', 6, 20, 480.00, 9600.00, 'approved', '2026-08-10 14:30:00', 'Engine overhaul maintenance kit'),
(103, 'SKU-4471', 'Marine Bearings, SKU-4471', 1, 200, 42.50, 8500.00, 'approved', '2026-07-15 09:15:00', 'Previous fulfilled PO with Oceanic Bearings Ltd');
