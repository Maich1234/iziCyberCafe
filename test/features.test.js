import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createPlatform} from '../src/server.js';
import {pageSelection,estimatePrint,countPages} from '../src/pricing.js';
import {availability} from '../src/marketplace.js';
import {pdfBase64,pdfBytes} from '../fixtures/pdf.js';
import {cupsArguments} from '../agent/print-agent.js';
import handler from '../api/index.js';

async function setup(t,mode='digital'){
  let result='paid',sequence=0;
  const app=await createPlatform({paymentProvider:{environment:'sandbox',initiate:async()=>({checkout:'check-'+(++sequence),merchant:'merchant-'+sequence}),query:async()=>result}});
  await app.provisionAdmin('admin@test.example','a-long-test-password');
  const servers={},cookies={};for(const role of ['customer','cafe','admin']){const server=http.createServer(app.handler(role));await new Promise(r=>server.listen(0,'127.0.0.1',r));servers[role]=server;}
  t.after(async()=>{await Promise.all(Object.values(servers).map(s=>new Promise(r=>s.close(r))));await app.close();});
  const origin=role=>`http://127.0.0.1:${servers[role].address().port}`;
  async function call(role,path,body,cookie=cookies[role]){const res=await fetch(origin(role)+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});if(res.headers.has('set-cookie'))cookies[role]=res.headers.get('set-cookie').split(';')[0];return {status:res.status,data:await res.json()};}
  for(const role of ['customer','cafe'])await call(role,'register',{email:role+'@test.example',password:'a-long-test-password',name:'Test Café',location:'Kisumu'});
  for(const role of ['customer','cafe','admin'])await call(role,'login',{email:role+'@test.example',password:'a-long-test-password'});
  await call('admin','cafes/review',{id:1,status:'approved'});
  await call('cafe','services',{name:'Test Service',price:100,fulfilment_mode:mode});
  const order=async()=>(await call('customer','orders',{service_id:1,instructions:'My order'})).data.id;
  const quote=async(id,amount=100)=>{const q=await call('cafe',`orders/${id}/quotes`,{amount,scope:'Agreed work',turnaround:'One working hour'});assert.equal(q.status,201,JSON.stringify(q));assert.equal((await call('customer',`orders/${id}/accept-quote`,{quote_id:q.data.id})).status,200);};
  const pay=async id=>{await call('customer',`orders/${id}/payment`,{phone:'0712345678'});await call('customer',`orders/${id}/payment/check`,{});};
  const detail=async id=>(await call('customer','orders/'+id)).data;
  return {call,order,quote,pay,detail,origin,cookies,setResult:r=>result=r};
}
test('PDF counts, range normalization, sheet rounding and CUPS selection agree',async()=>{
  assert.equal(await countPages(await pdfBytes('pages',7)),7);
  await assert.rejects(countPages(Buffer.from('%PDF-1.7 fake')),/readable/);
  assert.deepEqual(pageSelection('5,1-3,2,7',7),{ranges:'1-3,5,7',count:5});
  for(const input of ['0','2-1','8','1;touch bad','1-999999999'])assert.throws(()=>pageSelection(input,7));
  const e=estimatePrint({price:10,rates:JSON.stringify({mono:5,colour_extra:15,duplex_extra:2,paper:{A4:{premium:3}}})},{selected_pages:5,copies:2,paper:'A4',paper_type:'premium',color:'color',sides:'two-sided-long-edge'});
  assert.deepEqual(e,{pages:10,sheets:6,base:10,printing:50,colour:150,paper:18,duplex:12,total:240});
  const args=cupsArguments('Desk',{id:1,copies:2,paper:'A3',paper_type:'premium',color:'color',sides:'two-sided-long-edge',page_ranges:'1-3,5,7'},'/tmp/file.pdf');assert.ok(args.includes('page-ranges=1-3,5,7'));assert.ok(args.includes('media-type=stationery-heavyweight'));
});
test('availability uses Nairobi hours and service pauses block new requests',async t=>{
  assert.equal(availability({accepting:1,hours:JSON.stringify([{day:4,open:480,close:1020}])},new Date('2026-10-29T06:00:00Z')).open,true);
  assert.equal(availability({accepting:1,hours:JSON.stringify([{day:4,open:480,close:1020}])},new Date('2026-10-29T17:00:00Z')).open,false);
  const f=await setup(t);await f.call('cafe','cafe/availability',{accepting:false,hours:[]});assert.equal((await f.call('customer','orders',{service_id:1,instructions:'test'})).status,409);
  await f.call('cafe','cafe/availability',{accepting:true,hours:[]});
  await f.call('cafe','services/1/settings',{available:false,eta_minutes:90});assert.equal((await f.call('customer','orders',{service_id:1,instructions:'test'})).status,404);
  const catalog=(await f.call('customer','catalog')).data;assert.equal(catalog.services[0].eta_minutes,90);assert.equal(catalog.services[0].available,0);
});
test('saved print charges cannot be changed by client quotes or later service rates',async t=>{
  const f=await setup(t,'print');await f.call('cafe','services/1/settings',{available:true,eta_minutes:30,rates:{mono:5,colour_extra:15,duplex_extra:2,paper:{A4:{premium:3}}}});
  const id=await f.order();const uploaded=await f.call('customer',`orders/${id}/files`,{name:'test.pdf',content:await pdfBase64('test',7)});
  const settings={file_id:uploaded.data.id,copies:2,paper:'A4',paper_type:'premium',color:'color',sides:'two-sided-long-edge',page_ranges:'1-3,5,7'};
  assert.equal((await f.call('customer',`orders/${id}/print-settings`,settings)).status,200);
  const d=await f.detail(id);assert.equal(JSON.parse(d.printing.options.estimate).total,330);
  assert.equal((await f.call('cafe',`orders/${id}/quotes`,{amount:1,scope:'bad',turnaround:'Today'})).status,409);
  await f.call('cafe','services/1/settings',{available:true,eta_minutes:30,rates:{mono:99,colour_extra:99,duplex_extra:99,paper:{A4:{premium:99}}}});
  await f.quote(id,330);await f.pay(id);const paid=await f.detail(id);assert.equal(paid.printing.job.page_ranges,'1-3,5,7');assert.equal(paid.payment.verified.amount,330);
  assert.equal((await f.call('customer',`orders/${id}/print-settings`,{...settings,page_ranges:'all'})).status,409);
});
test('cancellation is blocked during payment uncertainty and after work; pre-work paid cancellation preserves ledger and tracks refund',async t=>{
  const f=await setup(t),id=await f.order();await f.quote(id);f.setResult('pending');await f.pay(id);
  assert.equal((await f.call('customer',`orders/${id}/cancel`,{reason:'Changed my mind'})).status,409);
  // Another paid order can be cancelled before any work begins.
  f.setResult('paid');const second=await f.order();await f.quote(second);await f.pay(second);
  assert.equal((await f.call('customer',`orders/${second}/cancel`,{reason:'Not needed'})).status,200);
  const cancelled=await f.detail(second);assert.equal(cancelled.order.refund_state,'pending');assert.equal(cancelled.payment.verified.amount,100);
  const record=await fetch(f.origin('customer')+`/api/orders/${second}/receipt.pdf`,{headers:{Cookie:f.cookies.customer}});assert.equal(record.status,200);assert.match(Buffer.from(await record.arrayBuffer()).subarray(0,5).toString(),/%PDF-/);
  assert.equal((await f.call('customer',`orders/${second}/quotes`,{amount:100})).status,409);
  assert.equal((await f.call('admin','refunds/record',{order_id:second,reference:'merchant-refund-test',confirmed:true})).status,200);
  const third=await f.order();await f.quote(third);await f.pay(third);assert.equal((await f.call('cafe',`orders/${third}/start-work`,{})).status,200);assert.equal((await f.call('customer',`orders/${third}/cancel`,{reason:'too late'})).status,409);
});
test('verification is explicit and reviews require a completed owned order',async t=>{
  const f=await setup(t),id=await f.order();assert.equal((await f.call('customer',`orders/${id}/review`,{rating:5,comment:'fake'})).status,409);
  assert.equal((await f.call('admin','cafes/verify',{id:1,verified:true,note:'Confirmed operator identity and address in person'})).status,200);
  assert.equal((await f.call('customer','cafes/1/profile')).data.cafe.verified,1);
  await f.quote(id);await f.pay(id);const file=await f.call('cafe',`orders/${id}/files`,{name:'final.pdf',content:await pdfBase64()});await f.call('cafe',`orders/${id}/deliver`,{file_id:file.data.id,note:'Finished'});const delivery=(await f.detail(id)).deliveries[0];await f.call('customer',`orders/${id}/approve-delivery`,{delivery_id:delivery.id});
  assert.equal((await f.call('customer',`orders/${id}/review`,{rating:5,comment:'Helpful and quick'})).status,200);assert.equal((await f.call('customer',`orders/${id}/review`,{rating:1,comment:'Duplicate'})).status,409);assert.equal((await f.call('customer','cafes/1/profile')).data.reviews.length,1);
  await f.call('customer','register',{email:'other@test.example',password:'a-long-test-password'});await f.call('customer','login',{email:'other@test.example',password:'a-long-test-password'});assert.equal((await f.call('customer',`orders/${id}/review`,{rating:5,comment:'Not mine'})).status,404);
});
test('reconciliation never trusts a manual paid flag; recovery is single-use and revokes sessions',async t=>{
  const f=await setup(t);const old=f.cookies.admin;
  assert.equal((await f.call('customer','payments/reconcile',{})).status,404);
  assert.equal((await f.call('admin','payments/reconcile',{})).status,200);
  assert.equal((await f.call('admin','admin/recovery-codes',{password:'wrong'})).status,401);
  const generated=await f.call('admin','admin/recovery-codes',{password:'a-long-test-password'});assert.equal(generated.data.codes.length,8);
  assert.equal((await f.call('admin','admin/recover',{email:'admin@test.example',code:generated.data.codes[0],password:'a-new-long-password'},'')).status,200);
  assert.equal((await f.call('admin','operations',undefined,old)).status,401);
  assert.equal((await f.call('admin','admin/recover',{email:'admin@test.example',code:generated.data.codes[1],password:'another-long-password'},'')).status,401);
  assert.equal((await f.call('admin','login',{email:'admin@test.example',password:'a-new-long-password'})).status,200);
  const ops=(await f.call('admin','operations')).data;assert.ok(ops.audit.some(a=>a.action==='admin.password_recovered'));assert.ok(!JSON.stringify(ops).includes(generated.data.codes[0]));
});
test('Vercel serves the actual interface even before database configuration',async t=>{
  const oldSurface=process.env.SURFACE,oldDb=process.env.DATABASE_URL;process.env.SURFACE='customer';delete process.env.DATABASE_URL;
  const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));if(oldSurface===undefined)delete process.env.SURFACE;else process.env.SURFACE=oldSurface;if(oldDb!==undefined)process.env.DATABASE_URL=oldDb;});
  const url=`http://127.0.0.1:${server.address().port}`;const page=await fetch(url);assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/html/);assert.match(await page.text(),/data-surface="customer"/);
  assert.equal((await fetch(url+'/api/session')).status,503);assert.equal((await fetch(url+'/features.js')).status,200);
});
test('edited PDFs cannot silently change the paid page count',async t=>{
  const f=await setup(t,'edit_and_print');await f.call('cafe','services/1/settings',{available:true,eta_minutes:60,rates:{mono:0,colour_extra:0,duplex_extra:0,paper:{A4:{plain:0}}}});
  const id=await f.order(),source=await f.call('customer',`orders/${id}/files`,{name:'source.pdf',content:await pdfBase64('source',2)});
  assert.equal((await f.call('customer',`orders/${id}/print-settings`,{file_id:source.data.id,copies:1,paper:'A4',paper_type:'plain',color:'monochrome',sides:'one-sided',page_ranges:'all'})).status,200);
  await f.quote(id);await f.pay(id);
  const final=await f.call('cafe',`orders/${id}/files`,{name:'changed.pdf',content:await pdfBase64('changed',3)});await f.call('cafe',`orders/${id}/deliver`,{file_id:final.data.id,note:'Final draft'});
  const delivery=(await f.detail(id)).deliveries[0];assert.equal((await f.call('customer',`orders/${id}/approve-delivery`,{delivery_id:delivery.id})).status,409);assert.equal((await f.detail(id)).printing.job,null);
});
