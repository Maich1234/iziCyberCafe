// Reports readiness without printing credential values or connection strings.
const surface=process.env.SURFACE||'all';
const requirements=['DATABASE_URL',...(surface==='admin'?['CRON_SECRET']:[])];
const missing=requirements.filter(key=>!process.env[key]);
console.log(JSON.stringify({surface,configured:missing.length===0,missing,payments_enabled:process.env.MPESA_ENABLED==='1'},null,2));
if(missing.length)process.exitCode=1;
