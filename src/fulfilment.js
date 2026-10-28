export function initializeFulfilment(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS deliveries(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),file_id INTEGER UNIQUE NOT NULL REFERENCES order_files(id),note TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS deliveries_order ON deliveries(order_id);`);
}
export function fulfilment({db,action,body,surface,user,order,fail,value,audit,send}) {
  if (!['deliver','approve-delivery','request-revision'].includes(action)) return false;
  const id=order.id;
  // Quote acceptance alone can never unlock fulfilment.
  if (!db.prepare('SELECT id FROM payments WHERE order_id=?').get(id)) fail('Verified payment is required before fulfilment.',409);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current=db.prepare('SELECT status FROM orders WHERE id=?').get(id);
    if (action==='deliver') {
      if (surface!=='cafe') fail('Only the assigned café can submit work.',403);
      if (!['in_progress','revision_requested'].includes(current.status)) fail('This order is not ready for a delivery.',409);
      if (!Number.isSafeInteger(body.file_id)) fail('Select a final document.');
      const file=db.prepare('SELECT id FROM order_files WHERE id=? AND order_id=? AND uploader=?').get(body.file_id,id,user.id);
      if (!file) fail('Select a document you uploaded to this order.');
      if (db.prepare('SELECT id FROM deliveries WHERE file_id=?').get(file.id)) fail('Upload a new document for this revision.',409);
      db.prepare('INSERT INTO deliveries(order_id,file_id,note) VALUES(?,?,?)').run(id,file.id,value(body.note,3000));
      db.prepare("UPDATE orders SET status='awaiting_review' WHERE id=?").run(id);
      audit(user.id,'order.delivered',id);
    } else {
      if (surface!=='customer') fail('Only the customer can review a delivery.',403);
      const delivery=Number.isSafeInteger(body.delivery_id) && db.prepare("SELECT id FROM deliveries WHERE id=? AND order_id=? AND status='pending'").get(body.delivery_id,id);
      if (!delivery || current.status!=='awaiting_review') fail('This delivery is no longer awaiting review.',409);
      if (action==='request-revision') {
        const note=value(body.note,3000);
        db.prepare('INSERT INTO order_messages(order_id,sender,message) VALUES(?,?,?)').run(id,user.id,'Revision requested: '+note);
      }
      db.prepare('UPDATE deliveries SET status=? WHERE id=?').run(action==='approve-delivery'?'approved':'revision_requested',delivery.id);
      db.prepare('UPDATE orders SET status=? WHERE id=?').run(action==='approve-delivery'?'completed':'revision_requested',id);
      audit(user.id,action==='approve-delivery'?'order.approved':'order.revision_requested',id);
    }
    db.exec('COMMIT');
  } catch(e) {db.exec('ROLLBACK');throw e;}
  send({ok:true});return true;
}
