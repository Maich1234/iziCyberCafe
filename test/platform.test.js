import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPlatform } from '../src/server.js';

test('registration, approval, catalog and tenant-isolated order flow', async t => {
  const app = createPlatform();
  app.provisionAdmin('admin@example.test', 'admin-test-password');
  const servers = {};
  for (const role of ['admin','cafe','customer']) {
    const server = http.createServer(app.handler(role));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers[role] = server;
  }
  t.after(async () => { await Promise.all(Object.values(servers).map(s => new Promise(r => s.close(r)))); app.close(); });
  async function call(role, path, body, cookie) {
    const res = await fetch(`http://127.0.0.1:${servers[role].address().port}/api/${path}`, { method: body === undefined ? 'GET':'POST', headers: {'Content-Type':'application/json', ...(cookie ? {Cookie:cookie}: {})}, ...(body===undefined?{}:{body:JSON.stringify(body)}) });
    return { status:res.status, cookie:res.headers.get('set-cookie')?.split(';')[0], data:await res.json() };
  }
  const register = (role,email,extra={}) => call(role,'register',{email,password:'test-password-123',...extra});
  assert.equal((await register('admin','bad@example.test')).status,403);
  assert.equal((await register('cafe','one@example.test',{name:'Kisumu Cyber',location:'Kisumu'})).status,201);
  await register('cafe','two@example.test',{name:'Nairobi Cyber',location:'Nairobi'});
  await register('customer','customer@example.test');
  const login = async (role,email,password='test-password-123') => (await call(role,'login',{email,password})).cookie;
  const owner = await login('cafe','one@example.test');
  const other = await login('cafe','two@example.test');
  const customer = await login('customer','customer@example.test');
  const admin = await login('admin','admin@example.test','admin-test-password');
  assert.equal((await call('admin','dashboard',undefined,owner)).status,401);
  assert.equal((await call('admin','dashboard',undefined,customer.replace('izi_customer','izi_admin'))).status,401);
  assert.equal((await call('cafe','services',{name:'CV formatting',price:500},owner)).status,403);
  assert.equal((await call('customer','catalog')).data.cafes.length,0);
  assert.equal((await call('admin','cafes/review',{id:1,status:'approved'},admin)).status,200);
  assert.equal((await call('cafe','services',{name:'CV formatting',price:500},owner)).status,201);
  assert.equal((await call('cafe','services',{name:'Bad price',price:-20},owner)).status,400);
  const catalog = (await call('customer','catalog')).data;
  assert.equal(catalog.cafes.length,1);
  assert.equal((await call('customer','orders',{service_id:1,instructions:'Format my CV',price:1,cafe_id:2},customer)).status,201);
  const order = (await call('cafe','dashboard',undefined,owner)).data.orders[0];
  assert.equal(order.price,500); assert.equal(order.cafe_id,1); assert.equal(order.status,'requested');
  assert.equal((await call('cafe','dashboard',undefined,other)).data.orders.length,0);
  await register('customer','other@example.test');
  const otherCustomer = await login('customer','other@example.test');
  assert.equal((await call('customer','dashboard',undefined,otherCustomer)).data.orders.length,0);
  assert.equal((await call('customer','cafes/review',{id:1,status:'approved'},customer)).status,404);
  await call('admin','cafes/review',{id:1,status:'suspended'},admin);
  assert.equal((await call('customer','orders',{service_id:1,instructions:'Another job'},customer)).status,404);
  await call('customer','logout',{},customer);
  assert.equal((await call('customer','dashboard',undefined,customer)).status,401);
});
