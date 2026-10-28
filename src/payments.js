import { randomUUID } from 'node:crypto';

export function initializePayments(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS payment_attempts(id TEXT PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),amount INTEGER NOT NULL,phone TEXT NOT NULL,environment TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'initiating',checkout TEXT UNIQUE,merchant TEXT,last_checked INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_payment ON payment_attempts(order_id) WHERE status IN ('initiating','pending','review','paid');
    CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY,order_id INTEGER UNIQUE NOT NULL REFERENCES orders(id),attempt_id TEXT UNIQUE NOT NULL REFERENCES payment_attempts(id),amount INTEGER NOT NULL,checkout TEXT UNIQUE NOT NULL,environment TEXT NOT NULL,created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
}
export function createPayments(db, provider, clock = Date.now) {
  if (provider && !['sandbox','live'].includes(provider.environment)) throw Error('Invalid payment provider environment.');
  if (provider && db.prepare('SELECT id FROM payment_attempts WHERE environment<>? LIMIT 1').get(provider.environment)) throw Error('Use separate databases for sandbox and live payments.');
  const checking=new Map();
  async function reconcile(id) {
    if (!provider) return;
    if (checking.has(id)) return checking.get(id);
    const check=(async()=>{
      const attempt=db.prepare('SELECT * FROM payment_attempts WHERE id=?').get(id);
      if (!attempt || !attempt.checkout || !['pending','review'].includes(attempt.status) || attempt.environment!==provider.environment) return;
      // Persist throttling across processes. A failure to reach the provider never marks an order paid.
      const claim=db.prepare('UPDATE payment_attempts SET last_checked=? WHERE id=? AND last_checked<?').run(clock(),id,clock()-10000);
      if (!claim.changes) return;
      let result;try {result=await provider.query(attempt);} catch {return;}
      if (!['paid','failed'].includes(result)) return;
      db.exec('BEGIN IMMEDIATE');
      try {
        const current=db.prepare('SELECT * FROM payment_attempts WHERE id=?').get(id);
        if (!['pending','review'].includes(current.status)) {db.exec('COMMIT');return;}
        if (result==='failed') db.prepare("UPDATE payment_attempts SET status='failed' WHERE id=?").run(id);
        else {
          const order=db.prepare('SELECT * FROM orders WHERE id=?').get(attempt.order_id);
          if (order.status!=='awaiting_payment' || order.price!==attempt.amount) {db.prepare("UPDATE payment_attempts SET status='review' WHERE id=?").run(id);db.exec('COMMIT');return;}
          db.prepare('INSERT INTO payments(order_id,attempt_id,amount,checkout,environment) VALUES(?,?,?,?,?)').run(order.id,id,attempt.amount,attempt.checkout,attempt.environment);
          db.prepare("UPDATE payment_attempts SET status='paid' WHERE id=?").run(id);
          db.prepare("UPDATE orders SET status='in_progress' WHERE id=?").run(order.id);
          db.prepare("INSERT INTO audit(actor,action,target) VALUES(?,'order.payment_verified',?)").run(order.customer_id,order.id);
        }
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
    })();checking.set(id,check);try {await check;} finally {checking.delete(id);}
  }
  async function route(ctx) {
    const {path,req,body,surface,user,fail,send}=ctx;
    if (path==='/api/payments/review' && req.method==='GET') {
      if (!user || user.role!=='admin' || surface!=='admin') fail('Not found',404);
      send({attempts:db.prepare("SELECT id,order_id,amount,environment,status,checkout,created,'••••' || substr(phone,-4) AS phone FROM payment_attempts ORDER BY rowid DESC LIMIT 100").all()});return true;
    }
    const callback=path.match(/^\/api\/payments\/mpesa\/callback\/([a-f0-9-]{36})$/);
    if (callback) {
      if (surface!=='customer' || req.method!=='POST') fail('Not found',404);
      const attempt=db.prepare('SELECT * FROM payment_attempts WHERE id=?').get(callback[1]);
      const event=body.Body?.stkCallback;
      // Callback content is only a hint. No callback amount, receipt or ResultCode is trusted.
      if (attempt && event?.CheckoutRequestID===attempt.checkout && event?.MerchantRequestID===attempt.merchant) await reconcile(attempt.id);
      send({ResultCode:0,ResultDesc:'Received'});return true;
    }
    const match=path.match(/^\/api\/orders\/([1-9]\d*)\/payment(?:\/(check))?$/);
    if (!match) return false;
    if (!user || surface!=='customer' || user.role!=='customer') fail('Not found',404);
    const order=db.prepare('SELECT orders.*,cafes.status AS cafe_status FROM orders JOIN cafes ON cafes.id=orders.cafe_id WHERE orders.id=? AND customer_id=?').get(Number(match[1]),user.id);
    if (!order) fail('Not found',404);
    if (req.method!=='POST') fail('Not found',404);
    if (!provider) fail('M-Pesa payments are not configured yet.',503);
    if (match[2]) {
      const attempt=db.prepare('SELECT * FROM payment_attempts WHERE order_id=? ORDER BY rowid DESC LIMIT 1').get(order.id);
      if (attempt) await reconcile(attempt.id);
      send({ok:true});return true;
    }
    if (order.cafe_status!=='approved') fail('This café is currently unavailable.',403);
    if (order.status!=='awaiting_payment') fail('Accept a quote before paying. Paid orders cannot be charged again.',409);
    const phone=String(body.phone||'').replace(/[\s+-]/g,'').replace(/^0/,'254');
    if (!/^254[17]\d{8}$/.test(phone)) fail('Enter a valid Kenyan mobile number.');
    const id=randomUUID();
    // Commit the intent before making a network request. Unknown outcomes block retries.
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT id FROM payment_attempts WHERE environment<>? LIMIT 1').get(provider.environment)) fail('Sandbox and live payments require separate databases.',409);
      const current=db.prepare('SELECT orders.status,price,cafes.status AS cafe_status FROM orders JOIN cafes ON cafes.id=orders.cafe_id WHERE orders.id=?').get(order.id);
      if (current.cafe_status!=='approved') fail('This café is currently unavailable.',403);
      if (current.status!=='awaiting_payment' || current.price!==order.price) fail('Refresh this order before paying.',409);
      if (db.prepare("SELECT id FROM payment_attempts WHERE order_id=? AND status IN ('initiating','pending','review','paid')").get(order.id)) fail('A payment is already pending. Check its status before trying again.',409);
      db.prepare('INSERT INTO payment_attempts(id,order_id,amount,phone,environment) VALUES(?,?,?,?,?)').run(id,order.id,order.price,phone,provider.environment);db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    try {
      const result=await provider.initiate({id,amount:order.price,phone});
      if (!result.checkout || !result.merchant) throw Error('Missing payment identifiers');
      db.prepare("UPDATE payment_attempts SET checkout=?,merchant=?,status='pending' WHERE id=?").run(result.checkout,result.merchant,id);
    }catch {
      db.prepare("UPDATE payment_attempts SET status='review' WHERE id=?").run(id);
      fail('The provider response is uncertain. Do not retry payment; contact support for reconciliation.',502);
    }
    send({message:'Payment prompt requested. Enter your PIN only on your phone.',environment:provider.environment},202);return true;
  }
  function summary(orderId) {
    const attempt=db.prepare('SELECT status,environment,created FROM payment_attempts WHERE order_id=? ORDER BY rowid DESC LIMIT 1').get(orderId);
    const payment=db.prepare('SELECT id,amount,environment,created FROM payments WHERE order_id=?').get(orderId);
    return {enabled:!!provider,environment:provider?.environment,attempt:attempt||null,verified:payment||null};
  }
  return {route,summary};
}
