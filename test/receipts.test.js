import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptData, receiptMarkup, receiptText } from '../public/receipt-printer.js';

const order={id:42,price:1,cafe:'Kisumu Cyber',service:'CV formatting'};
const verified={id:8,amount:700,created:'2026-10-28 10:30:00',environment:'sandbox'};

test('receipt uses verified ledger values and Nairobi verification time',()=>{
  const receipt=receiptData(order,verified);
  assert.equal(receipt.reference,'IZI-PAY-000008');
  assert.equal(receipt.amount,700);
  assert.equal(receipt.order,'IZI-42');
  assert.match(receipt.issued,/13:30/);
  assert.match(receipt.issued,/EAT$/);
  assert.match(receiptText(receipt),/NO REAL PAYMENT/);
  assert.match(receiptText(receipt),/not an M-Pesa SMS receipt number/);
  assert.equal(receiptData(order,null),null);
  assert.equal(receiptData(order,{...verified,amount:0}),null);
});
test('unverified states cannot render paper, downloads or replay',()=>{
  for(const status of ['pending','initiating','review','failed']) {
    const html=receiptMarkup({order,payment:{verified:null,attempt:{status}}});
    assert.doesNotMatch(html,/class="receipt-paper"/);
    assert.doesNotMatch(html,/data-replay-receipt|Download receipt|TOTAL PAID|Payment confirmed/);
  }
  assert.equal(receiptMarkup({order,payment:{verified:null,attempt:null}}),'');
});
test('customer receipt escapes order fields and never implies fulfilment or physical printing',()=>{
  const data={order:{...order,service:'<img src=x onerror=alert(1)>',cafe:'Cafe & Co'},payment:{verified}};
  const html=receiptMarkup(data);
  assert.match(html,/&lt;img/);assert.match(html,/Cafe &amp; Co/);
  assert.doesNotMatch(html,/<img/);
  assert.match(html,/data-replay-receipt/);assert.match(html,/orders\/42\/receipt/);
  assert.doesNotMatch(html,/Order complete|Paper printed|Tax|VAT/);
  assert.equal(receiptMarkup(data,'cafe'),'');assert.equal(receiptMarkup(data,'admin'),'');
});
