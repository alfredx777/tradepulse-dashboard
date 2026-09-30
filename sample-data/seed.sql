-- Fictional sample data for demos and screenshots.
-- Not real business data.
INSERT INTO transactions (product, customer, year, month, quantity, total_value) VALUES
('Sample Rice 25kg', 'Demo Customer A', 2026, 'January', 40, 2400.00),
('Sample Rice 25kg', 'Demo Customer B', 2026, 'February', 25, 1500.00),
('Sample Cooking Oil 5L', 'Demo Customer A', 2026, 'January', 60, 3300.00),
('Sample Cooking Oil 5L', 'Demo Customer C', 2026, 'March', 35, 1925.00),
('Sample Sugar 50kg', 'Demo Customer B', 2026, 'February', 18, 2700.00),
('Sample Sugar 50kg', 'Demo Customer C', 2026, 'April', 22, 3300.00),
('Sample Tomato Paste Carton', 'Demo Customer A', 2026, 'March', 50, 2000.00),
('Sample Tomato Paste Carton', 'Demo Customer D', 2026, 'May', 30, 1200.00),
('Sample Spaghetti Carton', 'Demo Customer D', 2026, 'April', 45, 1800.00),
('Sample Spaghetti Carton', 'Demo Customer B', 2026, 'May', 38, 1520.00),
('Sample Rice 25kg', 'Demo Customer C', 2026, 'May', 55, 3300.00),
('Sample Cooking Oil 5L', 'Demo Customer D', 2026, 'February', 28, 1540.00);

INSERT INTO batches (batch_number, batch_date, supplier) VALUES
('BATCH-001', '2026-01-05', 'Demo Supplier One'),
('BATCH-002', '2026-03-10', 'Demo Supplier Two');

INSERT INTO batch_items (batch_id, seq_in_batch, item_code, name, size, price, initial_quantity, quantity_remaining) VALUES
(1, 1, 'B001-01', 'Sample Rice 25kg', '25kg', 60.00, 120, 40),
(1, 2, 'B001-02', 'Sample Cooking Oil 5L', '5L', 55.00, 150, 27),
(2, 1, 'B002-01', 'Sample Sugar 50kg', '50kg', 150.00, 60, 20),
(2, 2, 'B002-02', 'Sample Spaghetti Carton', 'Carton', 40.00, 100, 17);