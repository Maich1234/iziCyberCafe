import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPlatform} from '../src/server.js';
import {createDatabase} from '../src/database.js';
import {runMaintenance,refreshPrintAlerts} from '../src/maintenance.js';
import {createPayments} from '../src/payments.js';

async function database(t){
  const dir=mkdtempSync(join(tmpdir(),'izi-maintenance-')),path=join(dir,'test.sqlite');
  const app=await createPlatform({database:path}),db=await createDatabase(path);
  t.after(async()=>{await db.close();await app.close();rmSync(dir,{recursive:true,force:true});});
  return db;
}
async function seed(db){
  db.exec('PRAGMA foreign_keys=ON');
  const user=db.prepare("INSERT INTO users(email,password,role) VALUES('owner@test.invalid','unused','cafe')").run().lastInsertRowid;
  const cafe=db.prepare("INSERT INTO cafes(owner_id,name,location,status) VALUES(?,'Test','Kisumu','approved')").run(user).lastInsertRowid;
  const service=db.prepare("INSERT INTO services(cafe_id,name,price) VALUES(?,'Test',100)").run(cafe).lastInsertRowid;
  const order=db.prepare("INSERT INTO orders(customer_id,cafe_id,service_id,instructions,price) VALUES(?,?,?,'Test',100)").run(user,cafe,service).lastInsertRowid;
  const file=db.prepare("INSERT INTO order_files(order_id,uploader,name,type,bytes) VALUES(?,?,'test.pdf','application/pdf',?)").run(order,user,Buffer.from('%PDF-')).lastInsertRowid;
  return {user,cafe,order,file};
}
test('maintenance lease excludes duplicates and records results without its secret',async t=>{
  const db=await database(t);let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);let checks=0;
  const payments={enabled:true,async reconcileBatch(){checks++;started();await gate;return {checked:2,needs_reference:1,deferred:0};}};
  const running=runMaintenance(db,payments);await ready;
  assert.equal((await runMaintenance(db,payments)).skipped,true);
  release();assert.equal((await running).payment.checked,2);assert.equal(checks,1);
  const result=db.prepare('SELECT status,last_finished,details FROM maintenance_jobs').get();assert.equal(result.status,'completed');assert.ok(result.last_finished);assert.equal(JSON.parse(result.details).payment.needs_reference,1);
  assert.equal((await runMaintenance(db,payments)).skipped,true);
});
test('maintenance records failure, and expired leases allow recovery',async t=>{
  const db=await database(t);
  await assert.rejects(runMaintenance(db,{enabled:true,reconcileBatch:async()=>{throw Error('simulated transport error');}}),/simulated/);
  assert.equal(db.prepare('SELECT status FROM maintenance_jobs').get().status,'failed');
  db.prepare('UPDATE maintenance_jobs SET lease_until=0').run();
  const result=await runMaintenance(db,{enabled:false});assert.equal(result.payment.enabled,false);assert.equal(db.prepare('SELECT status FROM maintenance_jobs').get().status,'completed');
});
test('automatic alerts deduplicate stalled jobs and never requeue them',async t=>{
  const db=await database(t),s=await seed(db);
  db.prepare("INSERT INTO print_jobs(order_id,file_id,cafe_id,environment,copies,paper,color,sides,status,updated_at) VALUES(?,?,?,'sandbox',1,'A4','monochrome','one-sided','claimed',?)").run(s.order,s.file,s.cafe,1000);
  assert.equal((await refreshPrintAlerts(db,1000000)).created,1);assert.equal((await refreshPrintAlerts(db,1000000)).created,0);
  assert.equal(db.prepare('SELECT status FROM print_jobs').get().status,'claimed');
  db.prepare("UPDATE print_jobs SET status='ready'").run();await refreshPrintAlerts(db,1000000);assert.equal(db.prepare('SELECT status FROM ops_alerts').get().status,'resolved');
});
test('reference-less payments do not starve queryable attempts in reconciliation',async t=>{
  const db=await database(t),s=await seed(db);let queries=0;
  for(let i=0;i<12;i++){
    const order=db.prepare("INSERT INTO orders(customer_id,cafe_id,service_id,instructions,price,status) VALUES(?,?,1,'Pending',100,'awaiting_payment')").run(s.user,s.cafe).lastInsertRowid;
    db.prepare("INSERT INTO payment_attempts(id,order_id,amount,phone,environment,status,checkout,merchant) VALUES(?,?,100,'254712345678','sandbox','review',?,?)").run('attempt-'+i,order,i===11?'known-checkout':null,i===11?'known-merchant':null);
  }
  const payments=await createPayments(db,{environment:'sandbox',query:async()=>{queries++;return 'paid';}});
  const result=await db.scope(()=>payments.reconcileBatch());assert.equal(queries,1);assert.equal(result.checked,1);assert.equal(result.needs_reference,11);assert.equal(db.prepare('SELECT count(*) AS n FROM payments').get().n,1);
});
test('cron requires the admin surface and secret; public health checks test database access',async t=>{
  const secret='a'.repeat(64),app=await createPlatform({maintenanceSecret:secret}),servers=[];
  t.after(async()=>{await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));await app.close();});
  for(const role of ['customer','admin']){
    const server=http.createServer(app.handler(role));await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.push(server);
    const base=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base+'/api/health')).status,200);
    const blocked=await fetch(base+'/api/cron/maintenance');assert.equal(blocked.status,role==='admin'?401:404);
    const accepted=await fetch(base+'/api/cron/maintenance',{headers:{Authorization:'Bearer '+secret}});assert.equal(accepted.status,role==='admin'?200:404);
    if(role==='admin'){const body=await accepted.json();assert.equal(body.payment.enabled,false);assert.equal((await fetch(base+'/api/cron/maintenance',{method:'POST',headers:{Authorization:'Bearer '+secret}})).status,401);}
  }
});
