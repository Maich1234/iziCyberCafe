import { Buffer } from 'node:buffer';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export function initializeWorkspace(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS order_files(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),uploader INTEGER NOT NULL REFERENCES users(id),name TEXT NOT NULL,type TEXT NOT NULL,bytes BLOB NOT NULL,created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS order_messages(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),sender INTEGER NOT NULL REFERENCES users(id),message TEXT NOT NULL,created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS quotes(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),amount INTEGER NOT NULL,scope TEXT NOT NULL,turnaround TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS order_files_order ON order_files(order_id);
    CREATE INDEX IF NOT EXISTS order_messages_order ON order_messages(order_id);
    CREATE INDEX IF NOT EXISTS quotes_order ON quotes(order_id);
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_quote ON quotes(order_id) WHERE status='pending';`);
}
export function orderWorkspace({ db, req, res, path, body, user, surface, send, fail, value, audit }) {
  const match = path.match(/^\/api\/orders\/([1-9]\d*)(?:\/(files|messages|quotes|accept-quote)(?:\/([1-9]\d*))?)?$/);
  if (!match) return false;
  // Admin oversight does not grant routine access to customer documents or conversations.
  if (surface === 'admin') fail('Order workspace not found.', 404);
  const id = Number(match[1]);
  const order = db.prepare('SELECT orders.*,cafes.owner_id,cafes.status AS cafe_status,services.name AS service,cafes.name AS cafe FROM orders JOIN cafes ON cafes.id=orders.cafe_id JOIN services ON services.id=orders.service_id WHERE orders.id=?').get(id);
  if (!order || (surface === 'customer' ? order.customer_id !== user.id : order.owner_id !== user.id)) fail('Order workspace not found.', 404);
  const action = match[2], fileId = match[3] && Number(match[3]);
  if (req.method === 'GET' && !action) {
    send({ order, files: db.prepare('SELECT id,name,type,length(bytes) AS size,created FROM order_files WHERE order_id=? ORDER BY id').all(id), messages: db.prepare('SELECT order_messages.id,message,created,users.role AS author FROM order_messages JOIN users ON users.id=sender WHERE order_id=? ORDER BY order_messages.id').all(id), quotes: db.prepare('SELECT * FROM quotes WHERE order_id=? ORDER BY id DESC').all(id) });
    return true;
  }
  if (req.method === 'GET' && action === 'files' && fileId) {
    if (surface === 'cafe' && order.cafe_status !== 'approved') fail('Café access is paused.', 403);
    const file = db.prepare('SELECT * FROM order_files WHERE id=? AND order_id=?').get(fileId, id);
    if (!file) fail('File not found.', 404);
    res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.bytes.length, 'Content-Disposition': `attachment; filename="document-${file.id}"; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'Cache-Control':'no-store', 'Content-Security-Policy':"sandbox; default-src 'none'" });
    res.end(Buffer.from(file.bytes));
    return true;
  }
  if (req.method !== 'POST' || fileId) fail('Not found', 404);
  if (order.cafe_status !== 'approved') fail('This café is currently unavailable. Order changes are paused.', 403);
  if (action === 'messages') {
    if (db.prepare('SELECT count(*) AS n FROM order_messages WHERE order_id=?').get(id).n >= 500) fail('Message limit reached.', 409);
    db.prepare('INSERT INTO order_messages(order_id,sender,message) VALUES(?,?,?)').run(id, user.id, value(body.message, 3000));
    send({ ok:true }, 201); return true;
  }
  if (action === 'files') {
    const name = value(body.name, 150);
    if (/[\x00-\x1f\x7f/\\]/.test(name)) fail('Use a simple filename without folders or control characters.');
    if (typeof body.content !== 'string') fail('Invalid file encoding.');
    if (body.content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) fail('Files must be between 1 byte and 5 MB.',413);
    if (body.content.length % 4 || /[^A-Za-z0-9+/=]/.test(body.content)) fail('Invalid file encoding.');
    const bytes = Buffer.from(body.content, 'base64');
    if (bytes.toString('base64') !== body.content) fail('Invalid file encoding.');
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) fail('Files must be between 1 byte and 5 MB.', 413);
    const ext = name.split('.').pop().toLowerCase();
    const types = {pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',txt:'text/plain'};
    const valid = ext === 'pdf' ? bytes.subarray(0,5).toString() === '%PDF-' : ext === 'png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : ['jpg','jpeg'].includes(ext) ? bytes[0]===255 && bytes[1]===216 && bytes[2]===255 : ext === 'txt' ? !bytes.includes(0) && Buffer.from(bytes.toString('utf8')).equals(bytes) : false;
    if (!valid || !types[ext]) fail('Upload a PDF, PNG, JPG or UTF-8 TXT file with a matching format.');
    const used = db.prepare('SELECT count(*) AS n FROM order_files WHERE order_id=?').get(id).n;
    if (used >= 20) fail('This order has reached its 20-file limit.', 409);
    const result = db.prepare('INSERT INTO order_files(order_id,uploader,name,type,bytes) VALUES(?,?,?,?,?)').run(id,user.id,name,types[ext],bytes);
    audit(user.id, 'order.file_uploaded', id);
    send({id:Number(result.lastInsertRowid)},201); return true;
  }
  if (action === 'quotes' && surface === 'cafe') {
    if (order.status === 'awaiting_payment') fail('The quote has already been accepted.',409);
    if (!Number.isSafeInteger(body.amount) || body.amount < 1 || body.amount > 10000000) fail('Enter a valid whole-shilling quote.');
    const scope=value(body.scope,3000), turnaround=value(body.turnaround,200);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT status FROM orders WHERE id=?').get(id).status === 'awaiting_payment') fail('The quote has already been accepted.',409);
      db.prepare("UPDATE quotes SET status='superseded' WHERE order_id=? AND status='pending'").run(id);
      const result=db.prepare('INSERT INTO quotes(order_id,amount,scope,turnaround) VALUES(?,?,?,?)').run(id,body.amount,scope,turnaround);
      db.prepare("UPDATE orders SET status='quoted' WHERE id=?").run(id);
      audit(user.id,'order.quoted',id); db.exec('COMMIT');
      send({id:Number(result.lastInsertRowid)},201);
    } catch(e) {db.exec('ROLLBACK'); throw e;}
    return true;
  }
  if (action === 'accept-quote' && surface === 'customer') {
    if (!Number.isSafeInteger(body.quote_id)) fail('Select a quote.');
    db.exec('BEGIN IMMEDIATE');
    try {
      const quote=db.prepare('SELECT * FROM quotes WHERE id=? AND order_id=?').get(body.quote_id,id);
      if (!quote || quote.status !== 'pending' || db.prepare('SELECT status FROM orders WHERE id=?').get(id).status !== 'quoted') fail('This quote is no longer available. Refresh the order.',409);
      db.prepare("UPDATE quotes SET status='accepted' WHERE id=?").run(quote.id);
      db.prepare("UPDATE orders SET status='awaiting_payment',price=? WHERE id=?").run(quote.amount,id);
      audit(user.id,'order.quote_accepted',id); db.exec('COMMIT');
    } catch(e) {db.exec('ROLLBACK'); throw e;}
    send({ok:true});return true;
  }
  fail('Not found',404);
}
