const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname))); // Serve index.html

// Initialize SQLite database
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        
        // Create Tables
        db.serialize(() => {
            // 0. Users table
            db.run(`CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE,
                password TEXT,
                name TEXT,
                role TEXT
            )`);

            // 1. Orders (Order Preparation)
            db.run(`CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                site_id TEXT,
                boq_details TEXT,
                vc TEXT,
                wbs TEXT,
                status TEXT
            )`);
            
            // 2. Shipments (Customs)
            db.run(`CREATE TABLE IF NOT EXISTS shipments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                awb TEXT,
                description TEXT,
                status TEXT,
                hs_code TEXT,
                eta TEXT
            )`);
            
            // 3. Inventory (Project WH GR/GI)
            db.run(`CREATE TABLE IF NOT EXISTS inventory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                reference TEXT,
                type TEXT, -- 'INBOUND' or 'OUTBOUND'
                items_count INTEGER,
                status TEXT
            )`);
            
            // 4. Call-offs (Material Call-off)
            db.run(`CREATE TABLE IF NOT EXISTS calloffs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mr TEXT,
                site TEXT,
                status TEXT, -- 'READY', 'ON_DELIVERY', 'POD_WAITING', 'COMPLETED'
                dsp TEXT
            )`);

            // Seed initial data if empty
            db.get("SELECT count(*) as count FROM orders", (err, row) => {
                if (row.count === 0) {
                    const insertOrder = db.prepare("INSERT INTO orders (site_id, boq_details, vc, wbs, status) VALUES (?, ?, ?, ?, ?)");
                    insertOrder.run("ORD-2026-901 / JKT-NORTH-01", "Baseband Unit v2", "VC-440-992", "NRO-CAPEX-26", "Clarified");
                    insertOrder.run("ORD-2026-902 / SBY-EAST-11", "Radio Antenna 5G", "VC-440-881", "Missing", "Pending");
                    insertOrder.finalize();

                    const insertShipment = db.prepare("INSERT INTO shipments (awb, description, status, hs_code, eta) VALUES (?, ?, ?, ?, ?)");
                    insertShipment.run("998-2342-111", "Shipment from Hub (EAB)", "In Transit", "8517.62.00", "12 Jul 2026");
                    insertShipment.finalize();

                    const insertInventory = db.prepare("INSERT INTO inventory (reference, type, items_count, status) VALUES (?, ?, ?, ?)");
                    insertInventory.run("PO: 450092110", "INBOUND", 12, "PENDING_GR");
                    insertInventory.run("MR: REQ-9920", "OUTBOUND", 5, "PENDING_GI");
                    insertInventory.finalize();

                    const insertCalloff = db.prepare("INSERT INTO calloffs (mr, site, status, dsp) VALUES (?, ?, ?, ?)");
                    insertCalloff.run("MR: 9920-A", "BDO-CEN-05", "READY", "Unassigned");
                    insertCalloff.run("MR: 9811-B", "JKT-SOU-12", "ON_DELIVERY", "Mitra Logistik PT");
                    insertCalloff.run("MR: 9102-C", "SBY-WES-01", "POD_WAITING", "Lintas Express");
                    insertCalloff.finalize();
                }
            });

            // Seed initial admin user if empty
            db.get("SELECT count(*) as count FROM users", (err, row) => {
                if (row.count === 0) {
                    db.run("INSERT INTO users (username, password, name, role) VALUES ('admin', 'password', 'Admin Utama', 'Supply Manager')");
                }
            });
        });
    }
});

// --- Auth APIs ---

app.post('/api/register', (req, res) => {
    const { username, password, name, role } = req.body;
    if (!username || !password || !name || !role) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    db.run("INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)", [username, password, name, role], function(err) {
        if (err) {
            if (err.message.includes('UNIQUE')) {
                return res.status(400).json({ error: 'Username already exists' });
            }
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, user: { username, name, role } });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user || user.password !== password) {
            return res.status(400).json({ error: 'Invalid username or password' });
        }
        res.json({ success: true, user: { username: user.username, name: user.name, role: user.role } });
    });
});

// --- REST APIs ---

// 1. Orders API
app.get('/api/orders', (req, res) => {
    db.all("SELECT * FROM orders", [], (err, rows) => {
        if (err) return res.status(500).json({error: err.message});
        res.json(rows);
    });
});
app.post('/api/orders', (req, res) => {
    const { site_id, boq_details, vc, wbs } = req.body;
    if (!site_id || !boq_details || !vc) {
        return res.status(400).json({ error: 'Site ID, BOQ details, and VC are required' });
    }
    const status = (wbs && wbs !== 'Missing') ? 'Clarified' : 'Pending';
    const finalWbs = wbs || 'Missing';
    db.run("INSERT INTO orders (site_id, boq_details, vc, wbs, status) VALUES (?, ?, ?, ?, ?)",
        [site_id, boq_details, vc, finalWbs, status], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        });
});
app.post('/api/orders/:id/approve', (req, res) => {
    db.run("UPDATE orders SET status = 'Clarified' WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({error: err.message});
        res.json({ success: true, updated: this.changes });
    });
});

// 2. Shipments API
app.get('/api/shipments', (req, res) => {
    db.all("SELECT * FROM shipments", [], (err, rows) => {
        if (err) return res.status(500).json({error: err.message});
        res.json(rows);
    });
});
app.post('/api/shipments', (req, res) => {
    const { awb, description, hs_code, eta } = req.body;
    if (!awb || !description || !hs_code || !eta) {
        return res.status(400).json({ error: 'All fields (AWB, description, HS Code, ETA) are required' });
    }
    db.run("INSERT INTO shipments (awb, description, status, hs_code, eta) VALUES (?, ?, 'In Transit', ?, ?)",
        [awb, description, hs_code, eta], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        });
});
app.post('/api/shipments/:id/submit-customs', (req, res) => {
    db.run("UPDATE shipments SET status = 'Customs Submitted' WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({error: err.message});
        res.json({ success: true, updated: this.changes });
    });
});

// 3. Inventory API
app.get('/api/inventory', (req, res) => {
    db.all("SELECT * FROM inventory", [], (err, rows) => {
        if (err) return res.status(500).json({error: err.message});
        res.json(rows);
    });
});
app.post('/api/inventory', (req, res) => {
    const { reference, type, items_count } = req.body;
    if (!reference || !type || !items_count) {
        return res.status(400).json({ error: 'Reference, type, and items count are required' });
    }
    const status = type === 'INBOUND' ? 'PENDING_GR' : 'PENDING_GI';
    db.run("INSERT INTO inventory (reference, type, items_count, status) VALUES (?, ?, ?, ?)",
        [reference, type, items_count, status], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        });
});
app.post('/api/inventory/:id/execute', (req, res) => {
    const { action } = req.body; // 'GR' or 'GI'
    const newStatus = action === 'GR' ? 'GR_COMPLETED' : 'GI_COMPLETED';
    db.run("UPDATE inventory SET status = ? WHERE id = ?", [newStatus, req.params.id], function(err) {
        if (err) return res.status(500).json({error: err.message});
        res.json({ success: true, updated: this.changes });
    });
});

// 4. Call-offs API
app.get('/api/calloffs', (req, res) => {
    db.all("SELECT * FROM calloffs", [], (err, rows) => {
        if (err) return res.status(500).json({error: err.message});
        res.json(rows);
    });
});
app.post('/api/calloffs', (req, res) => {
    const { mr, site, dsp } = req.body;
    if (!mr || !site) {
        return res.status(400).json({ error: 'Material Request (MR) and Site are required' });
    }
    const finalDsp = dsp || 'Unassigned';
    const status = finalDsp === 'Unassigned' ? 'READY' : 'ON_DELIVERY';
    db.run("INSERT INTO calloffs (mr, site, status, dsp) VALUES (?, ?, ?, ?)",
        [mr, site, status, finalDsp], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        });
});
app.post('/api/calloffs/:id/status', (req, res) => {
    const { status } = req.body; 
    db.run("UPDATE calloffs SET status = ? WHERE id = ?", [status, req.params.id], function(err) {
        if (err) return res.status(500).json({error: err.message});
        res.json({ success: true, updated: this.changes });
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`ERP Backend running on http://localhost:${PORT}`);
});
