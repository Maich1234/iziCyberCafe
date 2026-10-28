// Original, dependency-free implementation inspired by the user-supplied reference:
// https://www.dqnamo.com/experiments/receipt-printer
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const currency = amount => new Intl.NumberFormat('en-KE',{style:'currency',currency:'KES',minimumFractionDigits:2}).format(amount);
const revealed = new Set();

export function receiptData(order, verified) {
  if (!verified || !Number.isSafeInteger(verified.id) || verified.id < 1 || !Number.isSafeInteger(verified.amount) || verified.amount < 1) return null;
  // SQLite timestamps are UTC, even when the browser is in another timezone.
  const date = new Date(String(verified.created).replace(' ','T')+'Z');
  const issued = Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat('en-KE',{timeZone:'Africa/Nairobi',year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date)+' EAT';
  return {reference:'IZI-PAY-'+String(verified.id).padStart(6,'0'),order:'IZI-'+order.id,cafe:order.cafe,service:order.service,amount:verified.amount,total:currency(verified.amount),issued,sandbox:verified.environment==='sandbox'};
}

export function receiptText(receipt) {
  return [
    'iziCyberCafe',
    receipt.sandbox ? 'SANDBOX TEST RECEIPT - NO REAL PAYMENT' : 'PAYMENT RECEIPT',
    '--------------------------------',
    `Receipt: ${receipt.reference}`, `Order: ${receipt.order}`, `Cafe: ${receipt.cafe}`,
    `Service: ${receipt.service}`, `Total paid: ${receipt.total}`, 'Paid with: M-Pesa',
    `Verified at: ${receipt.issued}`, '--------------------------------',
    'Payment confirmed. Track fulfilment in your order.',
    'This is an iziCyberCafe payment reference, not an M-Pesa SMS receipt number.', ''
  ].join('\n');
}

export function receiptMarkup({order,payment}, surface='customer') {
  if (surface!=='customer' || (!payment.verified && !payment.attempt)) return '';
  const receipt=receiptData(order,payment.verified);
  const stage=receipt?'confirmed':payment.attempt?.status==='review'?'review':payment.attempt?.status==='failed'?'failed':'waiting';
  const labels={confirmed:'Payment confirmed',waiting:'Waiting for M-Pesa confirmation',review:'Payment needs checking',failed:'Payment not completed'};
  return `<section class="receipt-experience" aria-label="Customer payment receipt" data-payment-receipt data-state="${stage}"${receipt?` data-receipt-id="${receipt.reference}"`:''}>
    <div class="receipt-intro"><p class="eyebrow">A LITTLE PROOF. ALL YOURS.</p><h3>Your payment, on paper.</h3><p class="micro">${receipt?'Keep this receipt for your records. Your order progress is shown separately.':'Your receipt will appear here once payment is verified.'}</p></div>
    <div class="receipt-device">
      <div class="receipt-hardware"><div class="receipt-hardware-top"><span class="receipt-logo" aria-hidden="true">izi<span>↗</span></span><span class="receipt-device-label">${receipt?.sandbox||payment.attempt?.environment==='sandbox'?'TEST MODE':'PAYMENT DESK'}</span></div>
        <div class="receipt-screen"><div class="receipt-screen-summary"><span>${escape(order.service)}</span><strong>${receipt?escape(receipt.total):currency(order.price)}</strong></div><p>${escape(order.cafe)}</p><div class="receipt-status" role="status" aria-live="polite"><span class="receipt-led" aria-hidden="true"></span><span data-receipt-status>${labels[stage]}</span></div></div>
        <div class="receipt-slot" aria-hidden="true"></div>
      </div>
      ${receipt?`<div class="receipt-output"><article class="receipt-paper" aria-label="Verified payment receipt"><div class="receipt-paper-brand">izi<span>CyberCafe</span><b aria-hidden="true">↗</b></div><p class="receipt-paper-caption">${receipt.sandbox?'SANDBOX TEST RECEIPT':'PAYMENT RECEIPT'}</p>${receipt.sandbox?'<p class="receipt-sandbox">TEST ONLY · NO REAL PAYMENT</p>':''}<div class="receipt-line-item"><strong>${escape(receipt.service)}</strong><span>${escape(receipt.total)}</span></div><p class="receipt-cafe">${escape(receipt.cafe)}</p><div class="receipt-total"><span>TOTAL PAID</span><strong>${escape(receipt.total)}</strong></div><dl class="receipt-meta"><div><dt>Receipt</dt><dd>${receipt.reference}</dd></div><div><dt>Order</dt><dd>${receipt.order}</dd></div><div><dt>Paid with</dt><dd>M-Pesa</dd></div><div><dt>Verified</dt><dd>${escape(receipt.issued)}</dd></div></dl><p class="receipt-thanks">Thank you for keeping it local.</p><p class="receipt-reference-note">Platform payment reference.<br>Your M-Pesa SMS has the provider receipt.</p><div class="receipt-bars" aria-hidden="true"></div><p class="receipt-stub">${receipt.reference}</p></article></div><div class="receipt-controls"><button type="button" data-replay-receipt aria-label="Replay receipt animation">↻ Replay</button><a href="/api/orders/${order.id}/receipt" download="${receipt.reference}.txt">Download receipt ↓</a></div>`:''}
    </div>
  </section>`;
}

export function mountReceiptPrinter(root) {
  const device=root?.querySelector('[data-payment-receipt]');
  if (!device?.dataset.receiptId) return () => {};
  const paper=device.querySelector('.receipt-paper');
  const replay=device.querySelector('[data-replay-receipt]');
  const status=device.querySelector('[data-receipt-status]');
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  let active;
  function ready() {
    device.classList.remove('is-feeding');
    status.textContent='Payment confirmed · Receipt ready';
    replay.disabled=false;
  }
  function play() {
    active?.cancel();
    ready();
    if (reduced.matches || !paper.animate) return;
    device.classList.add('is-feeding');
    status.textContent='Payment confirmed · Preparing receipt';
    replay.disabled=true;
    // Feed real paper content from behind the slot; this never changes payment state.
    active=paper.animate([{transform:'translateY(-102%)'},{transform:'translateY(0)'}],{duration:1850,easing:'steps(14, end)'});
    active.finished.then(ready,()=>{});
  }
  function preferenceChanged() {if(reduced.matches){active?.cancel();ready();}}
  replay.addEventListener('click',play);
  reduced.addEventListener('change',preferenceChanged);
  if (!revealed.has(device.dataset.receiptId)) {revealed.add(device.dataset.receiptId);play();} else ready();
  return () => {active?.cancel();replay.removeEventListener('click',play);reduced.removeEventListener('change',preferenceChanged);};
}
