import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPlatform } from '../src/server.js';
import { createPayments } from '../src/payments.js';
import { createMpesa } from '../src/mpesa.js';

async function fixture(t,{uncertain=false,providerEnabled=true}={}) {
  let time=Date.now(), outcome='pending', queries=0, initiated=0;
  const directory=mkdtempSync(join(tmpdir(),'izi-payments-'));
  const database=join(directory,'test.sqlite');
  const calls=[];
  const provider={environment:'sandbox',async initiate(data){initiated++;calls.push(data);if(uncertain) throw Error('network timeout');return {checkout:'checkout-'+initiated,merchant:'merchant-'+initiated};},async query(){queries++;if(outcome==='unreachable')throw Error('network down');return outcome;}};
  const platform=createPlatform({database,paymentProvider:providerEnabled?provider:null,paymentClock:()=>time});
  platform.provisionAdmin('admin@example.test','test-password-123');
  const servers={};
  for(const role of ['customer','cafe','admin']) {const server=http.createServer(platform.handler(role));await new Promise(r=>server.listen(0,'127.0.0.1',r));servers[role]=server;}
  const origin=role=>`http://127.0.0.1:${servers[role].address().port}`;
  const cookies={};
  async function call(role,path,body,extra={}) {
    const response=await fetch(origin(role)+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(cookies[role]?{Cookie:cookies[role]}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(response.headers.has('set-cookie'))cookies[role]=response.headers.get('set-cookie').split(';')[0];
    return {status:response.status,data:await response.json()};
  }
  for(const role of ['cafe','customer']) await call(role,'register',{email:role+'@example.test',password:'test-password-123',name:'Test Café',location:'Kisumu'});
  for(const role of ['admin','cafe','customer']) await call(role,'login',{email:role+'@example.test',password:'test-password-123'});
  await call('admin','cafes/review',{id:1,status:'approved'});
  await call('cafe','services',{name:'CV formatting',price:500});
  await call('customer','orders',{service_id:1,instructions:'Format a two-page CV'});
  await call('cafe','orders/1/quotes',{amount:700,scope:'Two pages and one revision',turnaround:'1 day after payment'});
  await call('customer','orders/1/accept-quote',{quote_id:1});
  const start=()=>call('customer','orders/1/payment',{phone:'0712345678',amount:1});
  const check=()=>{time+=11000;return call('customer','orders/1/payment/check',{});};
  const detail=async()=>(await call('customer','orders/1')).data;
  const callback=(event={},pathId=calls[0]?.id)=>call('customer','payments/mpesa/callback/'+pathId,{Body:{stkCallback:{CheckoutRequestID:'checkout-1',MerchantRequestID:'merchant-1',ResultCode:0,...event}}},{Origin:'https://provider.example'});
  t.after(async()=>{await Promise.all(Object.values(servers).map(s=>new Promise(r=>s.close(r))));platform.close();rmSync(directory,{recursive:true,force:true});});
  return {call,start,check,detail,callback,calls,setOutcome:v=>{outcome=v;},get queries(){return queries;},get initiated(){return initiated;},database};
}

test('verified payment unlocks versioned delivery, revision and final customer approval',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('cafe','orders/1/deliver',{file_id:1,note:'Done'})).status,409);
  assert.equal((await f.start()).status,202);
  assert.equal(f.calls[0].amount,700);assert.equal(f.calls[0].phone,'254712345678');
  assert.equal((await f.start()).status,409);assert.equal(f.initiated,1);
  // A forged successful callback cannot make an order paid while provider query is pending.
  assert.equal((await f.callback()).status,200);
  assert.equal((await f.detail()).order.status,'awaiting_payment');
  assert.equal((await f.detail()).payment.verified,null);
  f.setOutcome('paid');await f.check();
  assert.equal((await f.detail()).order.status,'in_progress');
  assert.equal((await f.detail()).payment.verified.amount,700);
  await Promise.all([f.callback(),f.callback(),f.check()]);
  const adminSummary=await f.call('admin','payments/review');
  assert.equal(adminSummary.data.attempts[0].phone,'••••5678');
  assert.equal((await f.call('customer','payments/review')).status,404);
  assert.equal((await f.call('customer','payments/mpesa/callback/invalid',{})).status,404);
  assert.equal((await f.start()).status,409);
  assert.equal((await f.call('cafe','orders/1/quotes',{amount:100,scope:'Changed',turnaround:'Tomorrow'})).status,409);
  const doc=Buffer.from('%PDF-1.7\nfinal work').toString('base64');
  const upload=await f.call('cafe','orders/1/files',{name:'final.pdf',content:doc});
  const fileId=upload.data.id;
  assert.equal((await f.call('customer','orders/1/deliver',{file_id:fileId,note:'Done'})).status,403);
  assert.equal((await f.call('cafe','orders/1/deliver',{file_id:fileId,note:'First version'})).status,200);
  let delivery=(await f.detail()).deliveries[0];
  assert.equal((await f.detail()).order.status,'awaiting_review');
  assert.equal((await f.call('cafe','orders/1/deliver',{file_id:fileId,note:'Duplicate'})).status,409);
  assert.equal((await f.call('cafe','orders/1/approve-delivery',{delivery_id:delivery.id})).status,403);
  assert.equal((await f.call('customer','orders/1/request-revision',{delivery_id:delivery.id,note:'Fix the heading'})).status,200);
  assert.equal((await f.call('customer','orders/1/approve-delivery',{delivery_id:delivery.id})).status,409);
  assert.equal((await f.call('cafe','orders/1/deliver',{file_id:fileId,note:'Same file'})).status,409);
  const next=await f.call('cafe','orders/1/files',{name:'revised.pdf',content:doc});
  await f.call('cafe','orders/1/deliver',{file_id:next.data.id,note:'Heading corrected'});
  delivery=(await f.detail()).deliveries[0];
  assert.equal((await f.call('customer','orders/1/approve-delivery',{delivery_id:delivery.id})).status,200);
  assert.equal((await f.detail()).order.status,'completed');
  assert.equal((await f.call('customer','orders/1/approve-delivery',{delivery_id:delivery.id})).status,409);
  const persisted=new DatabaseSync(f.database);
  assert.equal(persisted.prepare('SELECT count(*) AS n FROM payments').get().n,1);
  assert.equal(persisted.prepare('SELECT amount FROM payments').get().amount,700);
  assert.equal(persisted.prepare('SELECT count(*) AS n FROM deliveries').get().n,2);
  assert.throws(()=>createPayments(persisted,{environment:'live'}),/separate databases/);
  assert.equal(persisted.prepare('PRAGMA integrity_check').get().integrity_check,'ok');persisted.close();
});
test('unconfigured payments fail closed without initiating a charge',async t=>{
  const f=await fixture(t,{providerEnabled:false});assert.equal((await f.start()).status,503);assert.equal(f.initiated,0);
});
test('uncertain initiation is persisted and blocks duplicate charging',async t=>{
  const f=await fixture(t,{uncertain:true});assert.equal((await f.start()).status,502);
  assert.equal((await f.detail()).payment.attempt.status,'review');
  assert.equal((await f.start()).status,409);assert.equal(f.initiated,1);
  await f.check();assert.equal((await f.detail()).payment.verified,null);
});
test('failed attempts permit retry, pending ones do not; untrusted callback identifiers are ignored',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('customer','orders/1/payment',{phone:'123'})).status,400);
  assert.equal((await f.call('cafe','orders/1/payment',{phone:'0712345678'})).status,404);
  const responses=await Promise.all([f.start(),f.start()]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[202,409]);assert.equal(f.initiated,1);
  await f.callback({CheckoutRequestID:'foreign-checkout'});assert.equal(f.queries,0);
  f.setOutcome('unreachable');await f.check();assert.equal((await f.detail()).payment.verified,null);
  assert.equal((await f.start()).status,409);
  f.setOutcome('failed');await f.check();assert.equal((await f.detail()).payment.attempt.status,'failed');
  assert.equal((await f.start()).status,202);assert.equal(f.initiated,2);
});
test('payment routes reject another customer and cross-site initiation',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('customer','orders/1/payment',{phone:'0712345678'},{Origin:'https://evil.example'})).status,403);
  await f.call('customer','register',{email:'other@example.test',password:'test-password-123'});
  await f.call('customer','login',{email:'other@example.test',password:'test-password-123'});
  assert.equal((await f.start()).status,404);assert.equal((await f.check()).status,404);assert.equal(f.initiated,0);
});

test('Daraja transport uses trusted configuration and correlates query responses',async()=>{
  assert.equal(createMpesa({}),null);
  assert.throws(()=>createMpesa({MPESA_ENABLED:'1'}));
  const config={MPESA_ENABLED:'1',MPESA_ENV:'sandbox',MPESA_CONSUMER_KEY:'test-key',MPESA_CONSUMER_SECRET:'test-secret',MPESA_SHORTCODE:'174379',MPESA_PASSKEY:'test-passkey',MPESA_CALLBACK_BASE:'https://customer.example'};
  let result={ResponseCode:'0',CheckoutRequestID:'checkout',MerchantRequestID:'merchant',ResultCode:'0'};const calls=[];
  const provider=createMpesa(config,async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.includes('/oauth/')?{access_token:'test-token',expires_in:3599}:result};});
  assert.deepEqual(await provider.initiate({id:'test-id',amount:700,phone:'254712345678'}),{checkout:'checkout',merchant:'merchant'});
  const payload=JSON.parse(calls[1].options.body);
  assert.equal(payload.Amount,700);assert.equal(payload.CallBackURL,'https://customer.example/api/payments/mpesa/callback/test-id');
  assert.match(payload.Timestamp,/^\d{14}$/);assert.equal(Buffer.from(payload.Password,'base64').toString(),'174379test-passkey'+payload.Timestamp);
  assert.equal(await provider.query({checkout:'checkout',merchant:'merchant'}),'paid');
  result={...result,MerchantRequestID:'foreign'};
  assert.equal(await provider.query({checkout:'checkout',merchant:'merchant'}),'pending');
  result={ResponseCode:'0',CheckoutRequestID:'checkout',MerchantRequestID:'merchant',ResultCode:1032};
  assert.equal(await provider.query({checkout:'checkout',merchant:'merchant'}),'failed');
  result={...result,ResultCode:9999};assert.equal(await provider.query({checkout:'checkout',merchant:'merchant'}),'pending');
  assert.equal(calls.filter(c=>c.url.includes('/oauth/')).length,1);
  assert.throws(()=>createMpesa({...config,MPESA_CALLBACK_BASE:'http://unsafe.example'}));
  assert.throws(()=>createMpesa({...config,MPESA_ENV:'typo'}));
});
