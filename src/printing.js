import { randomBytes, createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(value).digest('hex');
export const PRINT_MODES = ['digital','print','edit_and_print'];
export function initializePrinting(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
  for (const table of ['services','orders']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='fulfilment_mode')) db.exec(`ALTER TABLE ${table} ADD COLUMN fulfilment_mode TEXT NOT NULL DEFAULT 'digital'`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS print_options(order_id INTEGER PRIMARY KEY REFERENCES orders(id),file_id INTEGER REFERENCES order_files(id),copies INTEGER NOT NULL,paper TEXT NOT NULL,color TEXT NOT NULL,sides TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS printers(id INTEGER PRIMARY KEY,cafe_id INTEGER NOT NULL REFERENCES cafes(id),name TEXT NOT NULL,environment TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,color INTEGER NOT NULL,duplex INTEGER NOT NULL,last_seen INTEGER);
    CREATE TABLE IF NOT EXISTS print_jobs(id INTEGER PRIMARY KEY,order_id INTEGER UNIQUE NOT NULL REFERENCES orders(id),file_id INTEGER NOT NULL REFERENCES order_files(id),cafe_id INTEGER NOT NULL REFERENCES cafes(id),environment TEXT NOT NULL,copies INTEGER NOT NULL,paper TEXT NOT NULL,color TEXT NOT NULL,sides TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',printer_id INTEGER REFERENCES printers(id),claim_token TEXT,attempt INTEGER NOT NULL DEFAULT 0,spool_id TEXT,created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS print_jobs_queue ON print_jobs(cafe_id,status,id);`);
  db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}
export function requirePrintOptions(db,order,fail) {
  if (order.fulfilment_mode==='digital') return;
  const options=db.prepare('SELECT * FROM print_options WHERE order_id=?').get(order.id);
  if (!options || (order.fulfilment_mode==='print' && !options.file_id)) fail('Choose print settings and a PDF before requesting a quote.',409);
}
// Called inside the payment/approval transaction, so payment and queuing cannot drift apart.
export function enqueuePrint(db,orderId,approvedFileId=null) {
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order || order.fulfilment_mode==='digital') return;
  const payment=db.prepare('SELECT environment FROM payments WHERE order_id=?').get(orderId);
  const options=db.prepare('SELECT * FROM print_options WHERE order_id=?').get(orderId);
  const fileId=order.fulfilment_mode==='print'?options?.file_id:approvedFileId;
  if (!payment || !options || !fileId) throw Error('Print eligibility is incomplete.');
  const file=db.prepare("SELECT id FROM order_files WHERE id=? AND order_id=? AND type='application/pdf'").get(fileId,orderId);
  if (!file) throw Error('Only an approved order PDF may be printed.');
  db.prepare('INSERT OR IGNORE INTO print_jobs(order_id,file_id,cafe_id,environment,copies,paper,color,sides) VALUES(?,?,?,?,?,?,?,?)').run(orderId,file.id,order.cafe_id,payment.environment,options.copies,options.paper,options.color,options.sides);
  db.prepare("UPDATE orders SET status='print_queued' WHERE id=?").run(orderId);
}
export function printSummary(db,id) {
  return {options:db.prepare('SELECT * FROM print_options WHERE order_id=?').get(id)||null,job:db.prepare('SELECT id,status,copies,paper,color,sides,attempt,created FROM print_jobs WHERE order_id=?').get(id)||null};
}
export function printOrderAction(ctx) {
  const {db,action,body,surface,user,order,fail,send}=ctx;
  if (action!=='print-settings') return false;
  if (surface!=='customer' || order.fulfilment_mode==='digital') fail('Not found',404);
  if (order.status!=='requested') fail('Print settings are frozen when the café quotes this order.',409);
  if (!Number.isSafeInteger(body.copies) || body.copies<1 || body.copies>100 || !['A4','Letter'].includes(body.paper) || !['monochrome','color'].includes(body.color) || !['one-sided','two-sided-long-edge'].includes(body.sides)) fail('Choose valid print settings.');
  let fileId=null;
  if (order.fulfilment_mode==='print') {
    if (!Number.isSafeInteger(body.file_id)) fail('Select a PDF you uploaded.');
    const file=db.prepare("SELECT id FROM order_files WHERE id=? AND order_id=? AND uploader=? AND type='application/pdf'").get(body.file_id,order.id,user.id);
    if (!file) fail('Select a PDF you uploaded to this order.');fileId=file.id;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT status FROM orders WHERE id=?').get(order.id).status!=='requested') fail('Print settings are frozen when the café quotes this order.',409);
    db.prepare('INSERT INTO print_options(order_id,file_id,copies,paper,color,sides) VALUES(?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET file_id=excluded.file_id,copies=excluded.copies,paper=excluded.paper,color=excluded.color,sides=excluded.sides').run(order.id,fileId,body.copies,body.paper,body.color,body.sides);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  send({ok:true});return true;
}
export function printerRoutes({db,path,req,body,surface,user,fail,value,send,audit}) {
  if (!path.startsWith('/api/printers') && !path.startsWith('/api/print-jobs')) return false;
  if (surface!=='cafe' || user?.role!=='cafe') fail('Not found',404);
  const cafe=db.prepare('SELECT * FROM cafes WHERE owner_id=?').get(user.id);
  if (path==='/api/printers' && req.method==='GET') {send({printers:db.prepare('SELECT id,name,environment,enabled,color,duplex,last_seen FROM printers WHERE cafe_id=?').all(cafe.id),jobs:db.prepare('SELECT id,order_id,status,environment,copies,paper,color,sides,attempt,spool_id,printer_id FROM print_jobs WHERE cafe_id=? ORDER BY id DESC').all(cafe.id)});return true;}
  if (req.method!=='POST') fail('Not found',404);
  if (cafe.status!=='approved') fail('Your café must be approved.',403);
  if (path==='/api/printers') {
    if (!['sandbox','live'].includes(body.environment) || typeof body.color!=='boolean' || typeof body.duplex!=='boolean') fail('Choose valid printer capabilities.');
    const token=randomBytes(32).toString('hex');
    const result=db.prepare('INSERT INTO printers(cafe_id,name,environment,token_hash,color,duplex) VALUES(?,?,?,?,?,?)').run(cafe.id,value(body.name),body.environment,digest(token),Number(body.color),Number(body.duplex));
    audit(user.id,'printer.created',Number(result.lastInsertRowid));send({id:Number(result.lastInsertRowid),token},201);return true;
  }
  const printerMatch=path.match(/^\/api\/printers\/([1-9]\d*)\/(pause|resume|rotate)$/);
  if (printerMatch) {
    const printer=db.prepare('SELECT id FROM printers WHERE id=? AND cafe_id=?').get(Number(printerMatch[1]),cafe.id);
    if (!printer) fail('Not found',404);
    if (printerMatch[2]==='rotate') {const token=randomBytes(32).toString('hex');db.prepare('UPDATE printers SET token_hash=? WHERE id=?').run(digest(token),printer.id);audit(user.id,'printer.token_rotated',printer.id);send({token});}
    else {db.prepare('UPDATE printers SET enabled=? WHERE id=?').run(Number(printerMatch[2]==='resume'),printer.id);audit(user.id,'printer.'+printerMatch[2],printer.id);send({ok:true});}return true;
  }
  const jobMatch=path.match(/^\/api\/print-jobs\/([1-9]\d*)\/(ready|requeue|collected)$/);
  if (!jobMatch) fail('Not found',404);
  const note=value(body.note,1000),action=jobMatch[2];
  db.exec('BEGIN IMMEDIATE');
  try {
    const job=db.prepare('SELECT * FROM print_jobs WHERE id=? AND cafe_id=?').get(Number(jobMatch[1]),cafe.id);
    if (!job) fail('Not found',404);
    if (action==='collected') {
      if (job.status!=='ready') fail('Confirm the complete printout before collection.',409);
      db.prepare("UPDATE print_jobs SET status='collected',claim_token=NULL WHERE id=?").run(job.id);db.prepare("UPDATE orders SET status='completed' WHERE id=?").run(job.order_id);
    } else if (action==='ready') {
      if (!['claimed','spooled','uncertain'].includes(job.status) || body.confirmed_printed!==true) fail('Confirm that every requested page and copy is physically printed.',409);
      db.prepare("UPDATE print_jobs SET status='ready',claim_token=NULL WHERE id=?").run(job.id);db.prepare("UPDATE orders SET status='ready_for_collection' WHERE id=?").run(job.order_id);
    } else {
      if (!['claimed','spooled','uncertain'].includes(job.status) || body.confirmed_not_printed!==true) fail('Check the physical printer and spool queue before retrying.',409);
      db.prepare("UPDATE print_jobs SET status='queued',printer_id=NULL,claim_token=NULL,spool_id=NULL WHERE id=?").run(job.id);db.prepare("UPDATE orders SET status='print_queued' WHERE id=?").run(job.order_id);
    }
    audit(user.id,'print.'+action,job.id);db.prepare('INSERT INTO order_messages(order_id,sender,message) VALUES(?,?,?)').run(job.order_id,user.id,`Print ${action}: ${note}`);db.exec('COMMIT');send({ok:true});
  }catch(e){db.exec('ROLLBACK');throw e;}return true;
}
export function printAgentRoutes({db,path,req,res,body,surface,fail,send}) {
  if (!path.startsWith('/api/print-agent/')) return false;
  if (surface!=='cafe') fail('Not found',404);
  const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const printer=token&&db.prepare('SELECT printers.*,cafes.status AS cafe_status FROM printers JOIN cafes ON cafes.id=printers.cafe_id WHERE token_hash=?').get(digest(token));
  if (!printer) fail('Invalid printer credential.',401);
  db.prepare('UPDATE printers SET last_seen=? WHERE id=?').run(Date.now(),printer.id);
  if (path==='/api/print-agent/claim' && req.method==='POST') {
    if (!printer.enabled || printer.cafe_status!=='approved') {send({job:null,paused:true});return true;}
    db.exec('BEGIN IMMEDIATE');
    try {
      const current=db.prepare('SELECT printers.enabled,cafes.status FROM printers JOIN cafes ON cafes.id=printers.cafe_id WHERE printers.id=?').get(printer.id);
      if(!current.enabled||current.status!=='approved'){db.exec('COMMIT');send({job:null,paused:true});return true;}
      if(db.prepare("SELECT id FROM print_jobs WHERE printer_id=? AND status='claimed'").get(printer.id)) {db.exec('COMMIT');send({job:null,attention:true});return true;}
      const job=db.prepare("SELECT * FROM print_jobs WHERE cafe_id=? AND environment=? AND status='queued' AND (color='monochrome' OR ?=1) AND (sides='one-sided' OR ?=1) ORDER BY id LIMIT 1").get(printer.cafe_id,printer.environment,printer.color,printer.duplex);
      if (!job) {db.exec('COMMIT');send({job:null});return true;}
      const claim=randomBytes(24).toString('hex');
      db.prepare("UPDATE print_jobs SET status='claimed',printer_id=?,claim_token=?,attempt=attempt+1 WHERE id=?").run(printer.id,claim,job.id);
      const file=db.prepare('SELECT bytes FROM order_files WHERE id=?').get(job.file_id);
      db.exec('COMMIT');send({job:{id:job.id,attempt:job.attempt+1,claim_token:claim,environment:job.environment,copies:job.copies,paper:job.paper,color:job.color,sides:job.sides,sha256:digest(file.bytes)}});
    }catch(e){db.exec('ROLLBACK');throw e;}return true;
  }
  const match=path.match(/^\/api\/print-agent\/jobs\/([1-9]\d*)\/(file|report)$/);
  if (!match) fail('Not found',404);
  const job=db.prepare('SELECT * FROM print_jobs WHERE id=? AND printer_id=?').get(Number(match[1]),printer.id);
  const claim=req.headers['x-print-claim'];
  if (!job || !claim || job.claim_token!==claim) fail('Print claim is unavailable.',404);
  if (match[2]==='file' && req.method==='GET') {
    if (job.status!=='claimed' || !printer.enabled || printer.cafe_status!=='approved') fail('Print claim is paused or already submitted.',409);
    const file=db.prepare('SELECT bytes FROM order_files WHERE id=?').get(job.file_id);
    res.writeHead(200,{'Content-Type':'application/pdf','Cache-Control':'no-store','Content-Disposition':'attachment; filename="print-job.pdf"'});res.end(Buffer.from(file.bytes));return true;
  }
  if (match[2]==='report' && req.method==='POST') {
    if (!['spooled','uncertain'].includes(body.status)) fail('Invalid print report.');
    if (body.status==='spooled' && (typeof body.spool_id!=='string'|| !/^[A-Za-z0-9_.-]{1,120}$/.test(body.spool_id))) fail('A spool identifier is required.');
    if (job.status===body.status && (body.status!=='spooled'||job.spool_id===body.spool_id)) {send({ok:true});return true;}
    if (job.status!=='claimed') fail('This claim has already been resolved.',409);
    db.exec('BEGIN IMMEDIATE');
    try {
      const update=db.prepare("UPDATE print_jobs SET status=?,spool_id=? WHERE id=? AND claim_token=? AND status='claimed'").run(body.status,body.status==='spooled'?body.spool_id:null,job.id,claim);
      if(!update.changes)fail('This claim has already been resolved.',409);
      db.prepare('UPDATE orders SET status=? WHERE id=?').run(body.status==='spooled'?'printing':'print_attention',job.order_id);
      db.exec('COMMIT');send({ok:true});
    }catch(e){db.exec('ROLLBACK');throw e;}return true;
  }
  fail('Not found',404);
}
