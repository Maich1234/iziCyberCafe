import {test} from 'node:test';
import assert from 'node:assert/strict';

test('only a configured admin deployment schedules the maintenance job',async()=>{
  const saved={SURFACE:process.env.SURFACE,DATABASE_URL:process.env.DATABASE_URL,CRON_SECRET:process.env.CRON_SECRET};
  try{
    process.env.DATABASE_URL='postgres://test.invalid/db';process.env.CRON_SECRET='x'.repeat(64);
    for(const surface of ['customer','cafe','admin']){
      process.env.SURFACE=surface;const {config}=await import('../vercel.js?surface='+surface);
      assert.equal(config.crons?.length||0,surface==='admin'?1:0);
      assert.equal(config.functions['api/index.js'].maxDuration,60);
    }
    process.env.SURFACE='admin';delete process.env.DATABASE_URL;
    assert.equal((await import('../vercel.js?surface=unconfigured')).config.crons,undefined);
  }finally{for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
