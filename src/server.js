import http from 'node:http';
import { initializeWorkspace, orderWorkspace, MAX_FILE_BYTES } from './order-workspace.js';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function createPlatform({ database = ':memory:' } = {}) {
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cafes(id INTEGER PRIMARY KEY,owner_id INTEGER UNIQUE REFERENCES users(id),name TEXT NOT NULL,location TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE IF NOT EXISTS services(id INTEGER PRIMARY KEY,cafe_id INTEGER REFERENCES cafes(id),name TEXT NOT NULL,price INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,customer_id INTEGER REFERENCES users(id),cafe_id INTEGER REFERENCES cafes(id),service_id INTEGER REFERENCES services(id),instructions TEXT NOT NULL,price INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'requested',created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor INTEGER REFERENCES users(id),action TEXT NOT NULL,target INTEGER,created TEXT DEFAULT CURRENT_TIMESTAMP);`);
  initializeWorkspace(db);
  const hash = password => { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(password, salt, 64).toString('hex'); };
  const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
  const value = (v, max = 200) => { if (typeof v !== 'string' || !v.trim() || v.trim().length > max) fail('Please check the required fields.'); return v.trim(); };
  function addUser(email, password, role) {
    email = value(email).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid email address.');
    if (typeof password !== 'string' || password.length < 12 || password.length > 200) fail('Use a password with 12–200 characters.');
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) fail('This email is already registered.', 409);
    return Number(db.prepare('INSERT INTO users(email,password,role) VALUES(?,?,?)').run(email, hash(password), role).lastInsertRowid);
  }
  function provisionAdmin(email, password) {
    const existing = db.prepare('SELECT role FROM users WHERE email=?').get(email.toLowerCase());
    if (existing && existing.role !== 'admin') fail('Admin email already belongs to another role.');
    if (!existing) addUser(email, password, 'admin');
  }
  const loginAttempts = new Map();
  const audit = (actor, action, target) => db.prepare('INSERT INTO audit(actor,action,target) VALUES(?,?,?)').run(actor, action, target);
  function handler(surface) {
    if (!['customer', 'cafe', 'admin'].includes(surface)) throw Error('Unknown surface');
    return async (req, res) => {
      const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.setHeader('Referrer-Policy', 'no-referrer');
      try {
        const path = new URL(req.url, 'http://localhost').pathname;
        if (!path.startsWith('/api/')) {
          if (req.method !== 'GET') fail('Method not allowed', 405);
          const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
          if (!assets[path]) fail('Not found', 404);
          let body = readFileSync(new URL('../public/' + assets[path][0], import.meta.url), 'utf8').replaceAll('__SURFACE__', surface);
          res.writeHead(200, { 'Content-Type': assets[path][1] }); return res.end(body);
        }
        let body = {};
        if (req.method === 'POST') {
          // JSON-only mutations and same-origin requests prevent cross-site form submissions.
          if (!req.headers['content-type']?.startsWith('application/json')) fail('JSON required', 415);
          if (req.headers.origin && req.headers.origin !== `${process.env.SECURE_COOKIES === '1' ? 'https' : 'http'}://${req.headers.host}`) fail('Invalid origin', 403);
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > ( /^\/api\/orders\/[1-9]\d*\/files$/.test(path) ? Math.ceil(MAX_FILE_BYTES * 4 / 3) + 2000 : 20000)) fail('Request too large', 413); chunks.push(chunk); }
          try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('Invalid JSON'); }
          if (!body || Array.isArray(body) || typeof body !== 'object') fail('Invalid request');
        }
        const cookieName = `izi_${surface}`;
        const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
        const user = token && db.prepare('SELECT users.id,email,role FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>?').get(token, Date.now());
        const role = surface === 'cafe' ? 'cafe' : surface;
        const cookie = t => `${cookieName}=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${t ? 28800 : 0}${process.env.SECURE_COOKIES === '1' ? '; Secure' : ''}`;
        if (path === '/api/session' && req.method === 'GET') return send({ surface, user: user?.role === role ? user : null });
        if (path === '/api/register' && req.method === 'POST') {
          if (surface === 'admin') fail('Admin accounts are provisioned by the operator.', 403);
          const name = surface === 'cafe' ? value(body.name) : null;
          const location = surface === 'cafe' ? value(body.location) : null;
          db.exec('BEGIN');
          try { const id = addUser(body.email, body.password, role); if (surface === 'cafe') db.prepare('INSERT INTO cafes(owner_id,name,location) VALUES(?,?,?)').run(id, name, location); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
          return send({ message: 'Account created. You can now sign in.' }, 201);
        }
        if (path === '/api/login' && req.method === 'POST') {
          const key = surface + ':' + req.socket.remoteAddress;
          const now = Date.now();
          for (const [k, v] of loginAttempts) if (v.until < now) loginAttempts.delete(k);
          const limit = loginAttempts.get(key) || { count: 0, until: now + 900000 };
          if (++limit.count > 30) fail('Too many sign-in attempts. Retry in 15 minutes.', 429);
          loginAttempts.set(key, limit);
          const account = db.prepare('SELECT * FROM users WHERE email=? AND role=?').get(String(body.email || '').toLowerCase().trim(), role);
          const [salt, stored] = (account?.password || hash('dummy-password')).split(':');
          const attempt = scryptSync(String(body.password || '').slice(0, 200), salt, 64);
          if (!account || !timingSafeEqual(attempt, Buffer.from(stored, 'hex'))) fail('Email or password is incorrect.', 401);
          const next = randomBytes(32).toString('hex');
          db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
          db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(next, account.id, Date.now() + 28800000);
          res.setHeader('Set-Cookie', cookie(next)); return send({ message: 'Signed in' });
        }
        if (path === '/api/logout' && req.method === 'POST') { db.prepare('DELETE FROM sessions WHERE token=?').run(token || ''); res.setHeader('Set-Cookie', cookie('')); return send({ ok: true }); }
        if (path === '/api/catalog' && req.method === 'GET' && surface === 'customer') return send({ cafes: db.prepare("SELECT id,name,location FROM cafes WHERE status='approved'").all(), services: db.prepare("SELECT services.* FROM services JOIN cafes ON cafes.id=services.cafe_id WHERE cafes.status='approved'").all() });
        if (!user || user.role !== role) fail('Please sign in to this workspace.', 401);
        if (path === '/api/dashboard' && req.method === 'GET') {
          if (surface === 'admin') return send({ cafes: db.prepare('SELECT id,name,location,status FROM cafes').all(), orders: db.prepare('SELECT orders.*,cafes.name AS cafe FROM orders JOIN cafes ON cafes.id=orders.cafe_id ORDER BY orders.id DESC').all() });
          if (surface === 'cafe') {
            const cafe = db.prepare('SELECT * FROM cafes WHERE owner_id=?').get(user.id);
            return send({ cafe, services: db.prepare('SELECT * FROM services WHERE cafe_id=?').all(cafe.id), orders: db.prepare('SELECT orders.*,services.name AS service FROM orders JOIN services ON services.id=orders.service_id WHERE orders.cafe_id=? ORDER BY orders.id DESC').all(cafe.id) });
          }
          return send({ orders: db.prepare('SELECT orders.*,cafes.name AS cafe,services.name AS service FROM orders JOIN cafes ON cafes.id=orders.cafe_id JOIN services ON services.id=orders.service_id WHERE customer_id=? ORDER BY orders.id DESC').all(user.id) });
        }
        if (path === '/api/cafes/review' && req.method === 'POST' && surface === 'admin') {
          if (!['approved', 'suspended'].includes(body.status)) fail('Invalid status');
          if (!db.prepare('SELECT id FROM cafes WHERE id=?').get(body.id)) fail('Café not found', 404);
          db.prepare('UPDATE cafes SET status=? WHERE id=?').run(body.status, body.id); audit(user.id, `cafe.${body.status}`, body.id); return send({ ok: true });
        }
        if (path === '/api/services' && req.method === 'POST' && surface === 'cafe') {
          const cafe = db.prepare("SELECT id FROM cafes WHERE owner_id=? AND status='approved'").get(user.id);
          if (!cafe) fail('Your café must be approved before publishing services.', 403);
          if (!Number.isSafeInteger(body.price) || body.price < 1 || body.price > 10000000) fail('Enter a valid price in whole Kenya shillings.');
          db.prepare('INSERT INTO services(cafe_id,name,price) VALUES(?,?,?)').run(cafe.id, value(body.name), body.price); return send({ ok: true }, 201);
        }
        if (path === '/api/orders' && req.method === 'POST' && surface === 'customer') {
          const service = db.prepare("SELECT services.* FROM services JOIN cafes ON cafes.id=services.cafe_id WHERE services.id=? AND cafes.status='approved'").get(body.service_id);
          if (!service) fail('Service is unavailable', 404);
          const result = db.prepare('INSERT INTO orders(customer_id,cafe_id,service_id,instructions,price) VALUES(?,?,?,?,?)').run(user.id, service.cafe_id, service.id, value(body.instructions, 5000), service.price);
          return send({ id: Number(result.lastInsertRowid) }, 201);
        }
        if (orderWorkspace({ db, req, res, path, body, user, surface, send, fail, value, audit })) return;
        // Payment-dependent transitions deliberately remain disabled until verified payment integration.
        fail('Not found', 404);
      } catch (e) { if (!e.status) console.error(e); send({ error: e.status ? e.message : 'Something went wrong. Please retry.' }, e.status || 500); }
    };
  }
  return { handler, provisionAdmin, close: () => db.close() };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync('data', { recursive: true });
  const app = createPlatform({ database: process.env.DATABASE_PATH || 'data/izi.sqlite' });
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) app.provisionAdmin(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
  const selected = process.env.SURFACE;
  for (const [surface, port] of [['customer', 3000], ['cafe', 3001], ['admin', 3002]]) {
    if (selected && selected !== surface) continue;
    http.createServer(app.handler(surface)).listen(selected ? Number(process.env.PORT || port) : port, process.env.HOST || '127.0.0.1', () => console.log(`${surface}: http://localhost:${selected ? process.env.PORT || port : port}`));
  }
}
