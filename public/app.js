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
function message(text) { notice.textContent = text; }
function bindForm(id, action) { document.querySelector(id)?.addEventListener('submit', async e => {e.preventDefault(); const button=e.target.querySelector('button'); button.disabled=true; try {await action(Object.fromEntries(new FormData(e.target)));} catch(error){message(error.message);} finally {button.disabled=false;} }); }
const badge = status => `<span class="badge ${escape(status)}">${escape(status)}</span>`;
function orders(rows) {
  return rows.length ? `<div class="table-wrap"><table><thead><tr><th>Order</th><th>Service / café</th><th>Instructions</th><th>Total</th><th>Status</th></tr></thead><tbody>${rows.map(o=>`<tr><td>#IZI-${o.id}</td><td>${escape(o.service || o.cafe)}</td><td class="instructions">${escape(o.instructions)}</td><td>${money(o.price)}</td><td>${badge(o.status)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Your next order starts here.<small>Requests will appear here as they arrive.</small></div>';
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
    content.innerHTML=`<div class="banner">Business status ${badge(data.cafe.status)}<span>${data.cafe.status==='approved'?'Your services are visible to customers.':'An operator must approve your café before you can publish services.'}</span></div><div class="split"><section><h2>Incoming requests</h2>${orders(data.orders)}<p class="micro">Requests are unpaid. Payment and fulfilment transitions will be added with verified payment integration.</p></section><section class="panel"><p class="eyebrow">YOUR SERVICE MENU</p><h2>Make your skills discoverable.</h2>${data.services.map(s=>`<div class="service"><span>${escape(s.name)}</span><strong>${money(s.price)}</strong></div>`).join('')||'<p>No services published yet.</p>'}${data.cafe.status==='approved'?'<form id="serviceform"><label>Service name<input name="name" required maxlength="200" placeholder="e.g. CV formatting"></label><label>Price (KES)<input name="price" type="number" min="1" max="10000000" step="1" required></label><button class="primary">Publish service ↗</button></form>':''}</section></div>`;
    bindForm('#serviceform',async d=>{await api('services',{...d,price:Number(d.price)});await render();message('Service published.');});
  } else {
    const catalog=await api('catalog');
    content.innerHTML=`<section><div class="section-title"><h2>Find your local expert</h2><input id="search" aria-label="Search cafés by name or location" placeholder="Search town or café…"></div><div class="cards" id="cafes"></div></section><section><h2>Your requests</h2>${orders(data.orders)}</section>`;
    const show=(query='')=>{document.querySelector('#cafes').innerHTML=catalog.cafes.filter(c=>(c.name+' '+c.location).toLowerCase().includes(query.toLowerCase())).map(c=>`<article class="card"><div class="cafe-icon">↗</div><p class="eyebrow">${escape(c.location)}</p><h3>${escape(c.name)}</h3><p class="micro">Approved café · Local services</p>${catalog.services.filter(s=>s.cafe_id===c.id).map(s=>`<button class="service choose" data-service="${s.id}"><span>${escape(s.name)}</span><strong>${money(s.price)} ↗</strong></button>`).join('')||'<p class="micro">Services coming soon.</p>'}</article>`).join('')||'<div class="empty">No cafés found.<small>Approved cafés will appear here when they join.</small></div>';document.querySelectorAll('[data-service]').forEach(b=>b.addEventListener('click',()=>request(catalog.services.find(s=>s.id===Number(b.dataset.service)))));};
    show();document.querySelector('#search').addEventListener('input',e=>show(e.target.value));
  }
}
function request(service) {
  const dialog=document.createElement('dialog');dialog.innerHTML=`<form id="requestform"><p class="eyebrow">NEW REQUEST</p><h2>${escape(service.name)}</h2><p>${money(service.price)} · Payment is not collected in this release.</p><label>Tell the café what you need<textarea name="instructions" required maxlength="5000" rows="5" placeholder="Describe the work and your preferred turnaround time. Do not include passwords or OTPs."></textarea></label><div class="actions"><button type="button" id="cancel">Cancel</button><button class="primary">Send request ↗</button></div></form>`; document.body.append(dialog);dialog.showModal(); dialog.addEventListener('close',()=>dialog.remove());document.querySelector('#cancel').onclick=()=>dialog.close();bindForm('#requestform',async d=>{await api('orders',{...d,service_id:service.id});dialog.close();await render();message('Request sent. You can track it below.');});
}
document.querySelector('#signout').onclick=async()=>{try{await api('logout',{});await render();}catch(e){message(e.message);}};
render().catch(e=>message(e.message));
