import { refreshPrintAlerts, runMaintenance } from './maintenance.js';
import { randomBytes,createHash,timingSafeEqual,scryptSync } from 'node:crypto';
const digest=v=>createHash('sha256').update(v).digest('hex');
export const hashPassword=password=>{const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(password,salt,64).toString('hex');};
export function passwordMatches(password,encoded){const [salt,stored]=(encoded||hashPassword('dummy-password')).split(':');const attempted=scryptSync(String(password||'').slice(0,200),salt,64);return !!encoded&&timingSafeEqual(attempted,Buffer.from(stored,'hex'));}
export async function limitAuth(db,key,fail){
  const id=digest(key),now=Date.now();
  await db.exec('BEGIN IMMEDIATE');
  try{
    await db.prepare('DELETE FROM auth_limits WHERE expires<?').run(now);
    await db.prepare('INSERT INTO auth_limits(limit_key,attempts,expires) VALUES(?,1,?) ON CONFLICT(limit_key) DO UPDATE SET attempts=auth_limits.attempts+1').run(id,now+900000);
    const limit=await db.prepare('SELECT attempts FROM auth_limits WHERE limit_key=?').get(id);
    await db.exec('COMMIT');if(limit.attempts>15)fail('Too many attempts. Retry in 15 minutes.',429);
  }catch(e){await db.exec('ROLLBACK');throw e;}
}
export async function recoveryRoutes({db,path,req,body,surface,user,fail,send,audit}){
  if(!['/api/admin/recovery-codes','/api/admin/recover'].includes(path))return false;
  if(surface!=='admin'||req.method!=='POST')fail('Not found',404);
  if(path.endsWith('recovery-codes')){
    if(user?.role!=='admin')fail('Please sign in.',401);
    await limitAuth(db,'recovery-rotate:'+user.id,fail);
    const account=await db.prepare('SELECT password FROM users WHERE id=?').get(user.id);
    if(!passwordMatches(body.password,account.password))fail('Current password is incorrect.',401);
    const codes=Array.from({length:8},()=>randomBytes(24).toString('hex')),expires=Date.now()+90*86400000;
    await db.exec('BEGIN IMMEDIATE');
    try{await db.prepare('DELETE FROM admin_recovery WHERE user_id=?').run(user.id);for(const code of codes)await db.prepare('INSERT INTO admin_recovery(token_hash,user_id,expires) VALUES(?,?,?)').run(digest(code),user.id,expires);await audit(user.id,'admin.recovery_codes_rotated',user.id);await db.exec('COMMIT');}catch(e){await db.exec('ROLLBACK');throw e;}
    send({codes,expires});return true;
  }
  const email=String(body.email||'').trim().toLowerCase();await limitAuth(db,'recovery:'+email,fail);
  if(typeof body.password!=='string'||body.password.length<12||body.password.length>200)fail('Use a new password of 12–200 characters.');
  const code=typeof body.code==='string'&&/^[a-f0-9]{48}$/.test(body.code)?body.code:'';
  await db.exec('BEGIN IMMEDIATE');
  try{
    const record=await db.prepare("SELECT admin_recovery.token_hash,users.id FROM admin_recovery JOIN users ON users.id=admin_recovery.user_id WHERE token_hash=? AND users.email=? AND users.role='admin' AND expires>?").get(digest(code),email,Date.now());
    if(!record)fail('The recovery details are invalid or expired.',401);
    await db.prepare('UPDATE users SET password=? WHERE id=?').run(hashPassword(body.password),record.id);
    await db.prepare('DELETE FROM sessions WHERE user_id=?').run(record.id);
    // Reset invalidates every old recovery code, not only the one presented.
    await db.prepare('DELETE FROM admin_recovery WHERE user_id=?').run(record.id);
    await audit(record.id,'admin.password_recovered',record.id);await db.exec('COMMIT');send({ok:true});
  }catch(e){await db.exec('ROLLBACK');throw e;}return true;
}
export async function operationsRoutes({db,path,req,body,surface,user,fail,value,send,audit,payments}){
  if(!['/api/operations','/api/payments/reconcile','/api/payments/reconciliation-note','/api/refunds/record','/api/operations/run'].includes(path))return false;
  if(!user||!['admin','cafe'].includes(surface)||user.role!==surface)fail('Not found',404);
  if(path==='/api/operations'&&req.method==='GET'){
    await refreshPrintAlerts(db);
    if(surface==='admin')send({maintenance:await db.prepare('SELECT name,lease_until,last_started,last_finished,status,details FROM maintenance_jobs ORDER BY name').all(),alerts:await db.prepare("SELECT * FROM ops_alerts ORDER BY id DESC LIMIT 100").all(),audit:await db.prepare('SELECT audit.*,users.email AS actor_email FROM audit LEFT JOIN users ON users.id=audit.actor ORDER BY audit.id DESC LIMIT 200').all(),refunds:await db.prepare("SELECT id,cafe_id,price,refund_state FROM orders WHERE refund_state<>'none' ORDER BY id DESC LIMIT 100").all()});
    else {const cafe=await db.prepare('SELECT id FROM cafes WHERE owner_id=?').get(user.id);send({alerts:await db.prepare('SELECT * FROM ops_alerts WHERE cafe_id=? ORDER BY id DESC LIMIT 100').all(cafe.id),audit:await db.prepare("SELECT audit.id,action,target,created FROM audit WHERE (action LIKE 'order.%' AND target IN (SELECT id FROM orders WHERE cafe_id=?)) OR actor=? ORDER BY audit.id DESC LIMIT 100").all(cafe.id,user.id)});}
    return true;
  }
  if(surface!=='admin'||req.method!=='POST')fail('Not found',404);
  if(path==='/api/operations/run'){send(await runMaintenance(db,payments,{actor:user.id}));return true;}
  if(path==='/api/payments/reconcile'){
    const result=await payments.reconcileBatch();await audit(user.id,'payments.reconciliation_checked',null);send(result);return true;
  }
  if(path==='/api/payments/reconciliation-note'){
    if(!await db.prepare('SELECT id FROM payment_attempts WHERE id=?').get(body.attempt_id))fail('Attempt not found',404);
    const note=value(body.note,2000);await db.prepare('INSERT INTO reconciliation_notes(attempt_id,actor,note) VALUES(?,?,?)').run(body.attempt_id,user.id,note);await audit(user.id,'payment.reconciliation_noted',null);send({ok:true});return true;
  }
  if(path==='/api/refunds/record'){
    const note=value(body.reference,200),order=await db.prepare("SELECT id FROM orders WHERE id=? AND refund_state='pending' AND status='cancelled'").get(body.order_id);
    if(!order||body.confirmed!==true)fail('Confirm an externally completed refund for a cancelled paid order.',409);
    await db.exec('BEGIN IMMEDIATE');try{const changed=await db.prepare("UPDATE orders SET refund_state='recorded' WHERE id=? AND refund_state='pending'").run(order.id);if(!changed.changes)fail('Refund already recorded.',409);await db.prepare("UPDATE ops_alerts SET status='resolved' WHERE alert_key=?").run('refund:'+order.id);await db.prepare('INSERT INTO order_messages(order_id,sender,message) VALUES(?,?,?)').run(order.id,user.id,'External refund recorded by support: '+note);await audit(user.id,'order.external_refund_recorded',order.id);await db.exec('COMMIT');send({ok:true});}catch(e){await db.exec('ROLLBACK');throw e;}return true;
  }
  fail('Not found',404);
}
