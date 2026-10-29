import { pdfBase64 } from '../fixtures/pdf.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from '../src/server.js';
import { cupsArguments, runOnce } from '../agent/print-agent.js';

async function fixture(t,mode='print') {
  let sequence=0;
  const app=await createPlatform({paymentProvider:{environment:'sandbox',async initiate(){sequence++;return {checkout:'checkout-'+sequence,merchant:'merchant-'+sequence};},async query(){return 'paid';}}});
  await app.provisionAdmin('admin@example.test','password-for-testing');
  const servers={},cookies={};
  for(const role of ['customer','cafe','admin']) {const server=http.createServer(app.handler(role));await new Promise(r=>server.listen(0,'127.0.0.1',r));servers[role]=server;}
  t.after(async()=>{await Promise.all(Object.values(servers).map(s=>new Promise(r=>s.close(r))));await app.close();});
  const origin=role=>`http://127.0.0.1:${servers[role].address().port}`;
  async function call(role,path,body,cookie=cookies[role]) {
    const res=await fetch(origin(role)+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(res.headers.has('set-cookie'))cookies[role]=res.headers.get('set-cookie').split(';')[0];return {status:res.status,data:await res.json()};
  }
  for(const role of ['cafe','customer'])await call(role,'register',{email:role+'@example.test',password:'password-for-testing',name:'Test Café',location:'Kisumu'});
  for(const role of ['cafe','customer','admin'])await call(role,'login',{email:role+'@example.test',password:'password-for-testing'});
  await call('admin','cafes/review',{id:1,status:'approved'});
  await call('cafe','services',{name:'Printing',price:100,fulfilment_mode:mode});
  await call('cafe','services/1/settings',{available:true,eta_minutes:60,rates:{mono:0,colour_extra:0,duplex_extra:0,paper:{A4:{plain:0}}}});
  await call('customer','orders',{service_id:1,instructions:'Please prepare my document.'});
  const upload=async(role,name='document.pdf')=>(await call(role,'orders/1/files',{name,content:await pdfBase64(name)})).data.id;
  const source=await upload('customer');
  const settings={file_id:source,copies:3,paper:'A4',color:'color',sides:'two-sided-long-edge'};
  const quote=()=>call('cafe','orders/1/quotes',{amount:100,scope:'All pages, three colour duplex copies',turnaround:'Today after payment'});
  async function pay() {await quote();await call('customer','orders/1/accept-quote',{quote_id:1});await call('customer','orders/1/payment',{phone:'0712345678'});return call('customer','orders/1/payment/check',{});}
  const detail=async()=>(await call('customer','orders/1')).data;
  const printer=async(extra={})=>(await call('cafe','printers',{name:'Front desk',environment:'sandbox',color:true,duplex:true,...extra})).data;
  async function agent(token,path,body,claim) {
    return fetch(origin('cafe')+'/api/print-agent/'+path,{method:path.endsWith('/file')?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(claim?{'X-Print-Claim':claim}:{})},...(path.endsWith('/file')?{}:{body:JSON.stringify(body||{})})});
  }
  return {call,origin,cookies,upload,source,settings,quote,pay,detail,printer,agent};
}
test('only paid PDF jobs are queued; agent claims are exclusive and collection follows staff confirmation',async t=>{
  const f=await fixture(t);
  assert.equal((await f.quote()).status,409);
  assert.equal((await f.call('customer','orders/1/print-settings',{...f.settings,file_id:999})).status,400);
  assert.equal((await f.call('customer','orders/1/print-settings',{...f.settings,copies:101})).status,400);
  assert.equal((await f.call('customer','orders/1/print-settings',f.settings)).status,200);
  const p=await f.printer();
  assert.equal((await (await f.agent(p.token,'claim')).json()).job,null);
  await f.pay();
  assert.equal((await f.detail()).order.status,'print_queued');
  assert.equal((await f.call('customer','orders/1/print-settings',{...f.settings,copies:1})).status,409);
  const mono=await f.printer({color:false,duplex:false});
  const live=await f.printer({environment:'live'});
  assert.equal((await (await f.agent(mono.token,'claim')).json()).job,null);
  assert.equal((await (await f.agent(live.token,'claim')).json()).job,null);
  const second=await f.printer();
  const claims=await Promise.all([f.agent(p.token,'claim').then(r=>r.json()),f.agent(second.token,'claim').then(r=>r.json())]);
  assert.equal(claims.filter(c=>c.job).length,1);
  const index=claims.findIndex(c=>c.job),job=claims[index].job,token=index?second.token:p.token;
  assert.equal((await (await f.agent(token,'claim')).json()).attention,true);
  const file=await f.agent(token,`jobs/${job.id}/file`,undefined,job.claim_token);
  assert.equal((await f.call('customer','orders/1/cancel',{reason:'Printer already claimed it'})).status,409);
  assert.equal(file.status,200);assert.match(await file.text(),/^%PDF-/);
  assert.equal((await f.agent(mono.token,`jobs/${job.id}/file`,undefined,job.claim_token)).status,404);
  assert.equal((await f.agent(token,`jobs/${job.id}/report`,{status:'spooled',spool_id:'Desk-1'},job.claim_token)).status,200);
  assert.equal((await f.agent(token,`jobs/${job.id}/report`,{status:'spooled',spool_id:'Desk-1'},job.claim_token)).status,200);
  assert.equal((await f.detail()).order.status,'printing');
  assert.equal((await f.call('cafe',`print-jobs/${job.id}/ready`,{note:'Done'})).status,409);
  assert.equal((await f.call('cafe',`print-jobs/${job.id}/ready`,{note:'Checked all copies',confirmed_printed:true})).status,200);
  assert.equal((await f.detail()).order.status,'ready_for_collection');
  assert.equal((await f.agent(token,`jobs/${job.id}/file`,undefined,job.claim_token)).status,404);
  assert.equal((await f.call('cafe',`print-jobs/${job.id}/collected`,{note:'Handed to customer'})).status,200);
  assert.equal((await f.detail()).order.status,'completed');
  const listed=(await f.call('cafe','printers')).data;
  assert.equal(listed.jobs.length,1);assert.equal(listed.printers[0].token_hash,undefined);
  assert.equal((await f.call('customer','printers')).status,404);
});
test('editing orders wait for exact final PDF approval before queuing',async t=>{
  const f=await fixture(t,'edit_and_print');await f.call('customer','orders/1/print-settings',f.settings);await f.pay();
  assert.equal((await f.detail()).order.status,'in_progress');assert.equal((await f.detail()).printing.job,null);
  const final=await f.upload('cafe','final.pdf');
  await f.call('cafe','orders/1/deliver',{file_id:final,note:'Edited final PDF'});
  assert.equal((await f.detail()).printing.job,null);
  const delivery=(await f.detail()).deliveries[0];
  assert.equal((await f.call('customer','orders/1/approve-delivery',{delivery_id:delivery.id})).status,200);
  const detail=await f.detail();assert.equal(detail.order.status,'print_queued');assert.equal(detail.printing.job.copies,3);
  assert.equal((await f.call('customer','orders/1/approve-delivery',{delivery_id:delivery.id})).status,409);
  const p=await f.printer();
  await f.call('admin','cafes/review',{id:1,status:'suspended'});
  assert.equal((await (await f.agent(p.token,'claim')).json()).paused,true);
  await f.call('admin','cafes/review',{id:1,status:'approved'});
  const claim=(await (await f.agent(p.token,'claim')).json()).job;
  assert.ok(claim);
  const output=await f.agent(p.token,`jobs/${claim.id}/file`,undefined,claim.claim_token);
  assert.match(await output.text(),/^%PDF-/);
});
test('uncertain spool outcomes require explicit reconciliation; stale claims cannot print a retry',async t=>{
  const f=await fixture(t);await f.call('customer','orders/1/print-settings',f.settings);await f.pay();const p=await f.printer();
  const directory=mkdtempSync(join(tmpdir(),'izi-agent-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const config={PRINT_ENABLE:'1',PRINT_AGENT_TOKEN:p.token,PRINT_PAYMENT_ENV:'sandbox',PRINT_API_ORIGIN:f.origin('cafe'),PRINT_CUPS_PRINTER:'Desk',PRINT_JOURNAL_DIR:directory};
  let submits=0;
  await assert.rejects(runOnce(config,{submit:async()=>{submits++;throw Error('spool timeout');}}),/timeout/);
  assert.equal(submits,1);assert.equal((await f.detail()).printing.job.status,'uncertain');
  assert.equal((await f.call('cafe','operations')).data.alerts.filter(a=>a.status==='open').length,1);
  assert.equal((await f.call('admin','operations')).data.alerts.filter(a=>a.status==='open').length,1);
  assert.equal((await runOnce(config,{submit:async()=>{throw Error('must not resubmit');}})).status,'idle');
  const job=(await f.detail()).printing.job;
  assert.equal((await f.call('cafe',`print-jobs/${job.id}/requeue`,{note:'Retry'})).status,409);
  assert.equal((await f.call('cafe',`print-jobs/${job.id}/requeue`,{note:'Checked output and cancelled old spool',confirmed_not_printed:true})).status,200);
  assert.equal((await runOnce(config,{submit:async args=>{submits++;assert.ok(args.includes('sides=two-sided-long-edge'));return {stdout:'request id is Desk-9 (1 file(s))'};}})).status,'spooled');
  assert.equal(submits,2);assert.equal((await f.detail()).printing.job.attempt,2);
  assert.equal((await runOnce(config)).status,'idle');
});
test('printer pause, credential rotation and tenant boundaries',async t=>{
  const f=await fixture(t);await f.call('customer','orders/1/print-settings',f.settings);await f.pay();const p=await f.printer();
  await f.call('cafe',`printers/${p.id}/pause`,{});
  assert.equal((await (await f.agent(p.token,'claim')).json()).paused,true);
  const rotated=(await f.call('cafe',`printers/${p.id}/rotate`,{})).data;
  assert.equal((await f.agent(p.token,'claim')).status,401);
  await f.call('cafe',`printers/${p.id}/resume`,{});
  const claim=(await (await f.agent(rotated.token,'claim')).json()).job;
  await f.call('cafe',`print-jobs/${claim.id}/requeue`,{note:'No spool submission occurred; checked printer',confirmed_not_printed:true});
  assert.equal((await f.agent(rotated.token,`jobs/${claim.id}/file`,undefined,claim.claim_token)).status,404);
  await f.call('cafe','register',{email:'other@example.test',password:'password-for-testing',name:'Other Café',location:'Nairobi'});
  await f.call('cafe','login',{email:'other@example.test',password:'password-for-testing'});
  await f.call('admin','cafes/review',{id:2,status:'approved'});
  assert.equal((await f.call('cafe','printers')).data.jobs.length,0);
  assert.equal((await f.call('cafe',`printers/${p.id}/rotate`,{})).status,404);
  assert.equal((await f.call('cafe',`print-jobs/${claim.id}/ready`,{note:'Wrong cafe',confirmed_printed:true})).status,404);
});
test('agent is opt-in and rejects command injection and unsupported settings',async()=>{
  await assert.rejects(runOnce({}),/PRINT_ENABLE/);
  assert.throws(()=>cupsArguments('Desk;touch hacked',{copies:1,paper:'A4',color:'color',sides:'one-sided'},'/tmp/doc.pdf'));
  assert.throws(()=>cupsArguments('Desk',{copies:1,paper:'A2',color:'color',sides:'one-sided'},'/tmp/doc.pdf'));
});
test('a lost spool report leaves the claim blocked instead of submitting again',async t=>{
  const f=await fixture(t);await f.call('customer','orders/1/print-settings',f.settings);await f.pay();const p=await f.printer();
  const directory=mkdtempSync(join(tmpdir(),'izi-agent-report-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const config={PRINT_ENABLE:'1',PRINT_AGENT_TOKEN:p.token,PRINT_PAYMENT_ENV:'sandbox',PRINT_API_ORIGIN:f.origin('cafe'),PRINT_CUPS_PRINTER:'Desk',PRINT_JOURNAL_DIR:directory};
  let submissions=0;
  await assert.rejects(runOnce(config,{request:async(url,options)=>{if(url.endsWith('/report'))throw Error('report network lost');return fetch(url,options);},submit:async()=>{submissions++;return {stdout:'request id is Desk-12 (1 file(s))'};}}),/network lost/);
  assert.equal((await f.detail()).printing.job.status,'claimed');
  const next=await runOnce(config,{submit:async()=>{submissions++;return {stdout:'unexpected'};}});
  assert.equal(next.status,'attention');assert.equal(submissions,1);
});
