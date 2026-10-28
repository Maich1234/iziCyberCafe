const surface = document.body.dataset.surface;
const app = document.querySelector('#app');
const notice = document.querySelector('#notice');
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = v => 'KES ' + Number(v).toLocaleString('en-KE');
const labels = {customer:'Customer',cafe:'Café workspace',admin:'Platform control'};
document.querySelector('#workspace').textContent = labels[surface];
document.title = `${labels[surface]} · iziCyberCafe`;
async function api(path, body) {
  const res = await fetch('/api/' + path, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await res.json(); if (!res.ok) throw Error(data.error); return data;
}
function message(text) {
  notice.textContent = text;
  const dialog=document.querySelector('dialog[open]');
  if(dialog) {let status=dialog.querySelector('.dialog-notice');if(!status){status=document.createElement('p');status.className='dialog-notice';status.setAttribute('role','status');status.setAttribute('aria-live','polite');dialog.prepend(status);}status.textContent=text;}
}
function bindForm(id, action) { document.querySelector(id)?.addEventListener('submit', async e => {e.preventDefault(); const button=e.target.querySelector('button[type="submit"], button.primary'); button.disabled=true; try {await action(Object.fromEntries(new FormData(e.target)));} catch(error){message(error.message);} finally {button.disabled=false;} }); }
const badge = status => `<span class="badge ${escape(status)}">${escape(status.replaceAll('_',' '))}</span>`;
function orders(rows) {
  return rows.length ? `<div class="table-wrap"><table><thead><tr><th>Order</th><th>Service / café</th><th>Instructions</th><th>Total</th><th>Status</th></tr></thead><tbody>${rows.map(o=>`<tr><td>${surface==='admin'?`#IZI-${o.id}`:`<button class="order-link" data-order="${o.id}">#IZI-${o.id} ↗</button>`}</td><td>${escape(o.service || o.cafe)}</td><td class="instructions">${escape(o.instructions)}</td><td>${money(o.price)}</td><td>${badge(o.status)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Your next order starts here.<small>Requests will appear here as they arrive.</small></div>';
}
function auth(register=false) {
  app.innerHTML = `<section class="auth"><div><p class="eyebrow">${surface==='admin'?'PLATFORM OPERATIONS':surface==='cafe'?'GROW YOUR BUSINESS':'YOUR NEIGHBOURHOOD, CONNECTED'}</p><h1>${surface==='admin'?'A clear view.<br>Across every café.':surface==='cafe'?'More customers.<br>Less back and forth.':'Big tasks.<br>Local hands.'}</h1><p class="lede">${surface==='admin'?'Review businesses and oversee requests in your dedicated operations workspace.':surface==='cafe'?'Bring your services online and manage customer requests in one dedicated workspace.':'Find a cyber café near you. Get help with documents, design, and everyday digital tasks.'}</p><div class="accent-line"></div><span class="micro">${surface==='admin'?'Restricted to provisioned platform operators.':'Built around the people who get things done.'}</span></div><section class="panel"><p class="eyebrow">${labels[surface]}</p><h2>${register?'Make yourself at home.':'Welcome back.'}</h2><form id="authform">${register&&surface==='cafe'?'<label>Business name<input name="name" required maxlength="200" autocomplete="organization"></label><label>Town or neighbourhood<input name="location" required maxlength="200"></label>':''}<label>Email address<input name="email" type="email" required autocomplete="username"></label><label>Password<input name="password" type="password" required minlength="12" maxlength="200" autocomplete="${register?'new-password':'current-password'}"></label><button class="primary">${register?'Create account':'Sign in'} <span>↗</span></button></form>${surface!=='admin'?`<button class="text" id="toggle">${register?'Already registered? Sign in':'New here? Create an account'}</button>`:''}</section></section>`;
  document.querySelector('#toggle')?.addEventListener('click',()=>auth(!register));
  bindForm('#authform',async data=>{await api(register?'register':'login',data); if(register){auth();message('Account created. Sign in to continue.');}else await render();});
}
async function render() {
  message(''); const {user}=await api('session'); document.querySelector('#signout').hidden=!user;
  if(!user) return auth();
  const data=await api('dashboard');
  const title=surface==='admin'?'The network, at a glance.':surface==='cafe'?'Your working day. Simplified.':'What can we help with?';
  app.innerHTML=`<section class="heading"><div><p class="eyebrow">${labels[surface]} / OVERVIEW</p><h1>${title}</h1><p class="lede">${surface==='admin'?'Keep the community moving. Review café applications and monitor requests.':surface==='cafe'?escape(data.cafe.name)+' · '+escape(data.cafe.location):'Good work starts with the right local café.'}</p></div><span class="identity">${escape(user.email)}</span></section><div id="content"></div>`;
  const content=document.querySelector('#content');
  if(surface==='admin') {
    content.innerHTML=`<div class="stats"><article><span>Registered cafés</span><strong>${data.cafes.length}</strong></article><article><span>Awaiting approval</span><strong>${data.cafes.filter(c=>c.status==='pending').length}</strong></article><article><span>Customer requests</span><strong>${data.orders.length}</strong></article></div><section><div class="section-title"><h2>Café network</h2><span>Review & manage</span></div><div class="cards">${data.cafes.map(c=>`<article class="card"><p class="eyebrow">${escape(c.location)}</p><h3>${escape(c.name)}</h3>${badge(c.status)}<div class="actions">${c.status!=='approved'?`<button data-review="${c.id}" data-status="approved">Approve café ↗</button>`:''}${c.status!=='suspended'?`<button data-review="${c.id}" data-status="suspended">Suspend</button>`:''}</div></article>`).join('')||'<div class="empty">Café applications will appear here.</div>'}</div></section><section><h2>Latest requests</h2>${orders(data.orders)}</section>`;
    document.querySelectorAll('[data-review]').forEach(b=>b.addEventListener('click',async()=>{try{await api('cafes/review',{id:Number(b.dataset.review),status:b.dataset.status}); await render();}catch(e){message(e.message);}}));
  } else if(surface==='cafe') {
    content.innerHTML=`<div class="banner">Business status ${badge(data.cafe.status)}<span>${data.cafe.status==='approved'?'Your services are visible to customers.':'An operator must approve your café before you can publish services.'}</span></div><div class="split"><section><h2>Incoming requests</h2>${orders(data.orders)}<p class="micro">Requests are unpaid. Open an order to exchange files, discuss requirements and send a quote. Work begins after verified payment.</p></section><section class="panel"><p class="eyebrow">YOUR SERVICE MENU</p><h2>Make your skills discoverable.</h2>${data.services.map(s=>`<div class="service"><span>${escape(s.name)}</span><strong>${money(s.price)}</strong></div>`).join('')||'<p>No services published yet.</p>'}${data.cafe.status==='approved'?'<form id="serviceform"><label>Service name<input name="name" required maxlength="200" placeholder="e.g. CV formatting"></label><label>Price (KES)<input name="price" type="number" min="1" max="10000000" step="1" required></label><button class="primary">Publish service ↗</button></form>':''}</section></div>`;
    bindForm('#serviceform',async d=>{await api('services',{...d,price:Number(d.price)});await render();message('Service published.');});
  } else {
    const catalog=await api('catalog');
    content.innerHTML=`<section><div class="section-title"><h2>Find your local expert</h2><input id="search" aria-label="Search cafés by name or location" placeholder="Search town or café…"></div><div class="cards" id="cafes"></div></section><section><h2>Your requests</h2>${orders(data.orders)}</section>`;
    const show=(query='')=>{document.querySelector('#cafes').innerHTML=catalog.cafes.filter(c=>(c.name+' '+c.location).toLowerCase().includes(query.toLowerCase())).map(c=>`<article class="card"><div class="cafe-icon">↗</div><p class="eyebrow">${escape(c.location)}</p><h3>${escape(c.name)}</h3><p class="micro">Approved café · Local services</p>${catalog.services.filter(s=>s.cafe_id===c.id).map(s=>`<button class="service choose" data-service="${s.id}"><span>${escape(s.name)}</span><strong>${money(s.price)} ↗</strong></button>`).join('')||'<p class="micro">Services coming soon.</p>'}</article>`).join('')||'<div class="empty">No cafés found.<small>Approved cafés will appear here when they join.</small></div>';document.querySelectorAll('[data-service]').forEach(b=>b.addEventListener('click',()=>request(catalog.services.find(s=>s.id===Number(b.dataset.service)))));};
    show();document.querySelector('#search').addEventListener('input',e=>show(e.target.value));
  }
}
function request(service) {
  const dialog=document.createElement('dialog');dialog.innerHTML=`<form id="requestform"><p class="eyebrow">NEW REQUEST</p><h2>${escape(service.name)}</h2><p>${money(service.price)} · Payment is not collected in this release.</p><label>Tell the café what you need<textarea name="instructions" required maxlength="5000" rows="5" placeholder="Describe the work and your preferred turnaround time. You can attach documents after sending. Do not include passwords or OTPs."></textarea></label><div class="actions"><button type="button" id="cancel">Cancel</button><button class="primary">Send request ↗</button></div></form>`; document.body.append(dialog);dialog.showModal(); dialog.addEventListener('close',()=>dialog.remove());document.querySelector('#cancel').onclick=()=>dialog.close();bindForm('#requestform',async d=>{const created=await api('orders',{...d,service_id:service.id});dialog.close();await render();await openOrder(created.id);message('Request sent. You can now attach documents.');});
}
document.querySelector('#signout').onclick=async()=>{try{await api('logout',{});await render();}catch(e){message(e.message);}};
render().catch(e=>message(e.message));

app.addEventListener('click', e => {
  const button=e.target.closest('[data-order]');
  if(button) openOrder(Number(button.dataset.order)).catch(error=>message(error.message));
});
async function openOrder(id) {
  let dialog=document.querySelector('#order-dialog');
  const isNew=!dialog;
  if(!dialog) {dialog=document.createElement('dialog');dialog.id='order-dialog';dialog.setAttribute('aria-label','Order workspace');dialog.className='order-dialog';document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());}
  let data;
  try {data=await api(`orders/${id}`);} catch(error) {if(isNew) dialog.remove();throw error;}
  const {order}=data, paused=order.cafe_status!=='approved';
  if(!dialog.isConnected) return;
  const pending=data.quotes.find(q=>q.status==='pending');
  dialog.innerHTML=`<div class="section-title"><div><p class="eyebrow">ORDER #IZI-${id}</p><h2>${escape(order.service)}</h2></div><button id="close-order" aria-label="Close order">Close ×</button></div><div class="banner">${badge(order.status)}<strong>${money(order.price)}</strong><span>${escape(order.cafe)}</span></div><p class="instructions">${escape(order.instructions)}</p><p class="micro">${paused?'This café is unavailable. Order changes are paused.':'Discuss the scope and agree a quote before work begins.'} ${order.status==='awaiting_payment'?'Your quote is accepted. Payments are not available yet; work and printing remain on hold.':''}</p><div class="order-grid"><section><h3>Documents</h3><p class="micro">Source documents and reference files · PDF, PNG, JPG or TXT · 5 MB per file · up to 20 files</p><ul class="files">${data.files.map(f=>`<li><a href="/api/orders/${id}/files/${f.id}" download>${escape(f.name)} ↓</a><span>${Math.ceil(f.size/1024)} KB</span></li>`).join('')||'<li>No documents attached yet.</li>'}</ul>${!paused?'<form id="uploadform"><label>Attach a document<input name="file" type="file" accept=".pdf,.png,.jpg,.jpeg,.txt" required></label><button type="submit">Upload document</button></form>':''}<h3>Quote history</h3>${data.quotes.map(q=>`<article class="quote"><div class="section-title"><strong>${money(q.amount)}</strong>${badge(q.status)}</div><p class="instructions">${escape(q.scope)}</p><p class="micro">Turnaround: ${escape(q.turnaround)}</p>${surface==='customer'&&q.status==='pending'&&!paused?`<button class="primary" id="accept-quote" data-quote="${q.id}">Accept quote · ${money(q.amount)}</button>`:''}</article>`).join('')||'<p class="micro">The café can confirm scope and pricing with a quote.</p>'}${surface==='cafe'&&!paused&&order.status!=='awaiting_payment'?`<form id="quoteform"><label>Total price (KES)<input name="amount" type="number" min="1" max="10000000" step="1" required></label><label>What is included<textarea name="scope" maxlength="3000" rows="3" required></textarea></label><label>Turnaround<input name="turnaround" maxlength="200" placeholder="e.g. Within 1 business day after payment" required></label><p class="micro">${pending?'Sending a new quote replaces the pending quote.':'The customer must accept this quote before payment.'}</p><button type="submit">Send quote</button></form>`:''}</section><section><h3>Conversation</h3><div class="messages">${data.messages.map(m=>`<article class="chat ${escape(m.author)}"><span class="eyebrow">${m.author==='cafe'?'CAFÉ':'CUSTOMER'}</span><p>${escape(m.message)}</p><time>${escape(m.created)} UTC</time></article>`).join('')||'<p class="micro">Use this conversation to clarify the work. Never share passwords or OTPs.</p>'}</div>${!paused?'<form id="messageform"><label>Message<textarea name="message" required maxlength="3000" rows="3"></textarea></label><button type="submit" class="primary">Send message ↗</button></form>':''}</section></div>`;
  document.querySelector('#close-order').onclick=()=>dialog.close();
  if(isNew) dialog.showModal();
  async function refresh(text) {await render(); await openOrder(id);message(text);}
  bindForm('#messageform',async d=>{await api(`orders/${id}/messages`,d);await refresh('Message sent.');});
  bindForm('#quoteform',async d=>{await api(`orders/${id}/quotes`,{...d,amount:Number(d.amount)});await refresh('Quote sent for customer approval.');});
  bindForm('#uploadform',async d=>{
    if(!d.file.size||d.file.size>5*1024*1024) throw Error('Choose a file between 1 byte and 5 MB.');
    const content=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(Error('Could not read this file.'));reader.readAsDataURL(d.file);});
    await api(`orders/${id}/files`,{name:d.file.name,content});await refresh('Document attached.');
  });
  document.querySelector('#accept-quote')?.addEventListener('click',async e=>{
    e.target.disabled=true;
    try{await api(`orders/${id}/accept-quote`,{quote_id:Number(e.target.dataset.quote)});await refresh('Quote accepted. Your order is awaiting payment.');}catch(error){message(error.message); e.target.disabled=false;}
  });
}
