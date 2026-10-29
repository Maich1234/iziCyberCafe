import { readFileSync } from 'node:fs';
const assets={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript'],'/printing.js':['printing.js','text/javascript'],'/features.js':['features.js','text/javascript'],'/receipt-printer.js':['receipt-printer.js','text/javascript'],'/style.css':['style.css','text/css']};
export function serveAssets(req,res,surface){
  const path=new URL(req.url,'http://localhost').pathname;
  if(path.startsWith('/api/'))return false;
  const asset=assets[path];
  if(!asset||!['GET','HEAD'].includes(req.method)){res.writeHead(404,{'Content-Type':'text/plain'});res.end('Page not found');return true;}
  const body=readFileSync(new URL('../public/'+asset[0],import.meta.url),'utf8').replaceAll('__SURFACE__',surface);
  res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",'Referrer-Policy':'no-referrer'});
  res.end(req.method==='HEAD'?'':body);return true;
}
