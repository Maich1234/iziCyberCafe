import { validateRates } from './pricing.js';
export function availability(cafe,now=new Date()){
  const hours=JSON.parse(cafe.hours||'[]');
  if(!cafe.accepting)return {open:false,label:'Temporarily not accepting orders'};
  if(!hours.length)return {open:true,label:'Hours not published · confirm turnaround with café'};
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Nairobi',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  const day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday),minutes=Number(parts.hour)*60+Number(parts.minute);
  const slot=hours.find(h=>h.day===day),open=!!slot&&minutes>=slot.open&&minutes<slot.close;
  return {open,label:open?'Open now':'Closed now',timezone:'Africa/Nairobi'};
}
export async function catalog(db){
  const cafes=await db.prepare("SELECT id,name,location,hours,accepting,verified FROM cafes WHERE status='approved'").all();
  for(const cafe of cafes){cafe.availability=availability(cafe);cafe.reviews=await db.prepare('SELECT count(*) AS count,avg(rating) AS rating FROM reviews WHERE cafe_id=?').get(cafe.id);}
  return {cafes,services:await db.prepare("SELECT services.* FROM services JOIN cafes ON cafes.id=services.cafe_id WHERE cafes.status='approved'").all()};
}
export async function marketplaceRoutes({db,path,req,body,surface,user,fail,value,send,audit}){
  const profile=path.match(/^\/api\/cafes\/([1-9]\d*)\/profile$/);
  if(profile&&surface==='customer'&&req.method==='GET'){
    const cafe=await db.prepare("SELECT id,name,location,hours,accepting,verified FROM cafes WHERE id=? AND status='approved'").get(Number(profile[1]));
    if(!cafe)fail('Café not found',404);
    send({cafe:{...cafe,availability:availability(cafe)},reviews:await db.prepare('SELECT rating,comment,created FROM reviews WHERE cafe_id=? ORDER BY id DESC LIMIT 50').all(cafe.id)});return true;
  }
  if(path==='/api/cafe/availability'&&surface==='cafe'&&req.method==='POST'){
    if(!Array.isArray(body.hours)||body.hours.length>7||typeof body.accepting!=='boolean')fail('Choose opening hours and availability.');
    const seen=new Set();
    for(const h of body.hours){if(!Number.isInteger(h.day)||h.day<0||h.day>6||seen.has(h.day)||!Number.isInteger(h.open)||!Number.isInteger(h.close)||h.open<0||h.close>1440||h.open>=h.close)fail('Use one same-day opening interval per day.');seen.add(h.day);}
    const cafe=await db.prepare('SELECT id FROM cafes WHERE owner_id=?').get(user.id);
    await db.prepare('UPDATE cafes SET hours=?,accepting=? WHERE id=?').run(JSON.stringify(body.hours),Number(body.accepting),cafe.id);
    await audit(user.id,'cafe.availability_changed',cafe.id);send({ok:true});return true;
  }
  const serviceMatch=path.match(/^\/api\/services\/([1-9]\d*)\/settings$/);
  if(serviceMatch&&surface==='cafe'&&req.method==='POST'){
    const service=await db.prepare("SELECT services.* FROM services JOIN cafes ON cafes.id=services.cafe_id WHERE services.id=? AND cafes.owner_id=? AND cafes.status='approved'").get(Number(serviceMatch[1]),user.id);
    if(!service)fail('Service not found',404);
    if(typeof body.available!=='boolean'||!Number.isInteger(body.eta_minutes)||body.eta_minutes<5||body.eta_minutes>43200)fail('Choose availability and a completion estimate of 5–43,200 minutes.');
    const rates=body.rates===undefined?service.rates:JSON.stringify(validateRates(body.rates));
    await db.prepare('UPDATE services SET available=?,eta_minutes=?,rates=? WHERE id=?').run(Number(body.available),body.eta_minutes,rates,service.id);
    await audit(user.id,'service.settings_changed',service.id);send({ok:true});return true;
  }
  if(path==='/api/cafes/verify'&&surface==='admin'&&req.method==='POST'){
    if(typeof body.verified!=='boolean')fail('Choose verification status.');
    const note=value(body.note,1000),cafe=await db.prepare('SELECT id,status FROM cafes WHERE id=?').get(body.id);
    if(!cafe)fail('Café not found',404);
    if(body.verified&&cafe.status!=='approved')fail('Approve this café before verifying its identity and location.',409);
    await db.prepare('UPDATE cafes SET verified=?,verification_note=? WHERE id=?').run(Number(body.verified),note,cafe.id);
    await audit(user.id,body.verified?'cafe.identity_verified':'cafe.verification_removed',cafe.id);send({ok:true});return true;
  }
  const match=path.match(/^\/api\/orders\/([1-9]\d*)\/(cancel|start-work|review)$/);
  if(!match||req.method!=='POST'||!['customer','cafe'].includes(surface))return false;
  await db.exec('BEGIN IMMEDIATE');
  try{
    const order=await db.prepare('SELECT orders.*,cafes.owner_id,cafes.status AS cafe_status FROM orders JOIN cafes ON cafes.id=orders.cafe_id WHERE orders.id=?').get(Number(match[1]));
    if(!order||(surface==='customer'?order.customer_id!==user.id:order.owner_id!==user.id))fail('Order not found',404);
    const action=match[2];
    if(action==='cancel'){
      if(['cancelled','completed','ready_for_collection','awaiting_review'].includes(order.status)||order.started_at)fail('Work has started or finished. Contact the café and support to resolve this order.',409);
      const active=await db.prepare("SELECT id FROM payment_attempts WHERE order_id=? AND status IN ('pending','initiating','review')").get(order.id);
      if(active)fail('The payment outcome must be reconciled before cancellation. Do not pay again.',409);
      const job=await db.prepare('SELECT status FROM print_jobs WHERE order_id=?').get(order.id);
      if(job&&job.status!=='queued')fail('The printer has claimed this job. Staff must resolve it before cancellation.',409);
      const paid=await db.prepare('SELECT id FROM payments WHERE order_id=?').get(order.id),reason=value(body.reason,1000);
      await db.prepare("UPDATE orders SET status='cancelled',cancel_reason=?,refund_state=? WHERE id=?").run(reason,paid?'pending':'none',order.id);
      await db.prepare("UPDATE print_jobs SET status='cancelled',claim_token=NULL WHERE order_id=? AND status='queued'").run(order.id);
      await db.prepare("UPDATE quotes SET status='cancelled' WHERE order_id=? AND status='pending'").run(order.id);
      if(paid)await db.prepare("INSERT OR IGNORE INTO ops_alerts(alert_key,cafe_id,order_id,kind,message) VALUES(?,?,?,'refund','Paid order cancelled before work started. Reconcile the customer refund.')").run('refund:'+order.id,order.cafe_id,order.id);
      await audit(user.id,'order.cancelled',order.id);
    }else if(action==='start-work'){
      if(surface!=='cafe'||order.cafe_status!=='approved'||order.fulfilment_mode==='print'||order.status!=='in_progress'||order.started_at)fail('This order cannot start work.',409);
      if(!await db.prepare('SELECT id FROM payments WHERE order_id=?').get(order.id))fail('Verified payment required.',409);
      await db.prepare('UPDATE orders SET started_at=? WHERE id=?').run(Date.now(),order.id);await audit(user.id,'order.work_started',order.id);
    }else{
      if(surface!=='customer'||order.status!=='completed')fail('Only a completed order can be reviewed by its customer.',409);
      if(!Number.isInteger(body.rating)||body.rating<1||body.rating>5)fail('Choose a rating from 1 to 5.');
      if(await db.prepare('SELECT id FROM reviews WHERE order_id=?').get(order.id))fail('This order has already been reviewed.',409);
      await db.prepare('INSERT INTO reviews(order_id,cafe_id,customer_id,rating,comment) VALUES(?,?,?,?,?)').run(order.id,order.cafe_id,user.id,body.rating,value(body.comment,1000));await audit(user.id,'order.reviewed',order.id);
    }
    await db.exec('COMMIT');send({ok:true});
  }catch(e){await db.exec('ROLLBACK');throw e;}
  return true;
}
