import { createPlatform } from '../src/server.js';
import { createMpesa } from '../src/mpesa.js';
let platform;
export default async function handler(req,res) {
  try {
    if(!['customer','cafe','admin'].includes(process.env.SURFACE))throw Error('Missing surface configuration');
    if(!process.env.DATABASE_URL)throw Error('Missing managed database configuration');
    platform ||= createPlatform({database:process.env.DATABASE_URL,paymentProvider:createMpesa()}).then(async app=>{
      try {
        if(process.env.SURFACE==='admin' && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
          await app.provisionAdmin(process.env.ADMIN_EMAIL,process.env.ADMIN_PASSWORD);
        }
        return app;
      }catch(error){await app.close();throw error;}
    }).catch(error=>{platform=null;throw error;});
    const app=await platform;
    return await app.handler(process.env.SURFACE)(req,res);
  }catch(error){
    console.error('Deployment configuration error',error.code||error.name);
    if(!res.headersSent){res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'The service is temporarily unavailable. Please retry.'}));}
  }
}
