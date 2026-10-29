import { randomBytes, timingSafeEqual } from 'node:crypto';

export function cronAuthorized(req,secret){
  if(req.method!=='GET'||typeof secret!=='string'||secret.length<32)return false;
  const supplied=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+secret);
  return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
}
export async function initializeMaintenance(db){
  await db.exec(`CREATE TABLE IF NOT EXISTS maintenance_jobs(name TEXT PRIMARY KEY,lease_token TEXT NOT NULL,lease_until BIGINT NOT NULL,last_started BIGINT NOT NULL,last_finished BIGINT,status TEXT NOT NULL,details TEXT NOT NULL DEFAULT '{}')`);
}
export async function refreshPrintAlerts(db,now=Date.now()){
  const jobs=await db.prepare("SELECT id,cafe_id,order_id FROM print_jobs WHERE status='uncertain' OR (status='claimed' AND updated_at<?)").all(now-600000);
  let created=0;
  for(const job of jobs){
    const result=await db.prepare("INSERT OR IGNORE INTO ops_alerts(alert_key,cafe_id,order_id,kind,message) VALUES(?,?,?,'print','Print submission needs staff reconciliation. Check the printer before any retry.')").run('print:'+job.id,job.cafe_id,job.order_id);
    created+=result.changes;
  }
  await db.prepare("UPDATE ops_alerts SET status='resolved' WHERE kind='print' AND order_id IN (SELECT order_id FROM print_jobs WHERE status IN ('ready','collected'))").run();
  return {attention:jobs.length,created};
}
export async function runMaintenance(db,payments,{now=Date.now,actor=null}={}){
  const started=now(),token=randomBytes(24).toString('hex');
  const claim=await db.prepare("INSERT INTO maintenance_jobs(name,lease_token,lease_until,last_started,status) VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until,last_started=excluded.last_started,status=excluded.status WHERE maintenance_jobs.lease_until<?").run('daily',token,started+300000,started,'running',started);
  if(!claim.changes)return {skipped:true,reason:'A maintenance run is active or recently finished.'};
  let status='failed',details={};
  try{
    const print=await refreshPrintAlerts(db,started);
    const payment=payments.enabled?await payments.reconcileBatch():{enabled:false,checked:0,needs_reference:0,deferred:0};
    const sessions=await db.prepare('DELETE FROM sessions WHERE expires<?').run(started);
    await db.prepare('DELETE FROM admin_recovery WHERE expires<?').run(started);
    await db.prepare('DELETE FROM auth_limits WHERE expires<?').run(started);
    details={print,payment,expired_sessions:sessions.changes};status='completed';
    await db.prepare("INSERT INTO audit(actor,action,target) VALUES(?,'operations.maintenance_completed',NULL)").run(actor);
    return {skipped:false,...details};
  }catch(error){
    details={error:'Maintenance did not finish. An operator must investigate.'};
    await db.prepare("INSERT INTO audit(actor,action,target) VALUES(?,'operations.maintenance_failed',NULL)").run(actor);
    throw error;
  }finally{
    // Lease ownership prevents a delayed invocation overwriting a newer run.
    const finished=now();
    await db.prepare('UPDATE maintenance_jobs SET lease_until=?,last_finished=?,status=?,details=? WHERE name=? AND lease_token=?').run(finished+60000,finished,status,JSON.stringify(details),'daily',token);
  }
}
export async function maintenanceRoute({db,payments,path,req,res,surface,secret}){
  if(path!=='/api/cron/maintenance')return false;
  const send=(data,status)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(surface!=='admin'){send({error:'Not found'},404);return true;}
  if(!cronAuthorized(req,secret)){send({error:'Unauthorized'},401);return true;}
  send(await runMaintenance(db,payments),200);return true;
}
