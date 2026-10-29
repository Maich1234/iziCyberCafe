import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
const tables=['users','sessions','cafes','services','orders','audit','order_files','order_messages','quotes','payment_attempts','payments','deliveries','print_options','printers','print_jobs','reviews','ops_alerts','reconciliation_notes','admin_recovery','auth_limits'];
const serialTables=new Set(tables.filter(t=>!['sessions','payment_attempts','print_options','admin_recovery','auth_limits'].includes(t)));

export function postgresSQL(input) {
  let index=0,quoted=false,sql='';
  for(let i=0;i<input.length;i++){
    const c=input[i];
    if(c==="'"){sql+=c;if(quoted&&input[i+1]==="'"){sql+=input[++i];continue;}quoted=!quoted;}
    else sql+=c==='?'&&!quoted?'$'+(++index):c;
  }
  const ignored=/^\s*INSERT OR IGNORE INTO/i.test(sql);
  sql=sql.replace(/INSERT OR IGNORE INTO/i,'INSERT INTO').replace(/\browid\b/gi,'sequence_id').replace(/substr\(phone,-4\)/gi,'right(phone,4)');
  sql=sql.replace(new RegExp('\\b(FROM|JOIN|UPDATE|INTO|REFERENCES)\\s+('+tables.join('|')+')\\b','gi'),(_,keyword,table)=>keyword+' izicybercafe.'+table);
  if(ignored)sql+=' ON CONFLICT DO NOTHING';
  const inserted=sql.match(/^\s*INSERT INTO izicybercafe\.(\w+)/i)?.[1];
  if(serialTables.has(inserted))sql+=' RETURNING id';
  return sql;
}
export async function createDatabase(location=':memory:') {
  if(!/^postgres(?:ql)?:\/\//.test(location)){
    if(process.env.VERCEL)throw Error('Vercel requires a persistent PostgreSQL DATABASE_URL.');
    const raw=new DatabaseSync(location);let queue=Promise.resolve();
    return {dialect:'sqlite',prepare:sql=>raw.prepare(sql),exec:sql=>raw.exec(sql),close:()=>raw.close(),async scope(task){const previous=queue;let unlock;queue=new Promise(r=>unlock=r);await previous;try{return await task();}finally{unlock();}}};
  }
  const pool=new pg.Pool({connectionString:location,max:3,idleTimeoutMillis:10000,connectionTimeoutMillis:10000,ssl:{rejectUnauthorized:true},application_name:'izicybercafe'});
  pool.on('error',()=>console.error('Database connection interrupted'));
  const storage=new AsyncLocalStorage();
  async function query(sql,args=[]) {
    const context=storage.getStore();
    const result=await (context?.client||pool).query(postgresSQL(sql),args.map(v=>v instanceof Uint8Array?Buffer.from(v):v));
    for(const field of result.fields||[])if(field.dataTypeID===20)for(const row of result.rows){const n=Number(row[field.name]);if(Number.isSafeInteger(n)&&row[field.name]!==null)row[field.name]=n;}
    return result;
  }
  return {
    dialect:'postgres',
    prepare(sql){return {async get(...args){return (await query(sql,args)).rows[0];},async all(...args){return (await query(sql,args)).rows;},async run(...args){const r=await query(sql,args);return {changes:r.rowCount,lastInsertRowid:r.rows[0]?.id};}};},
    async exec(sql){
      const context=storage.getStore();
      if(/^BEGIN/i.test(sql)){
        if(!context||context.client)throw Error('Transaction requires an isolated request context.');
        context.client=await pool.connect();
        try{await context.client.query('BEGIN');await context.client.query('SELECT pg_advisory_xact_lock(91827411)');}
        catch(error){context.client.release();context.client=null;throw error;}
      }else if(/^(COMMIT|ROLLBACK)$/i.test(sql)){
        if(!context?.client)return;
        try{await context.client.query(sql);}finally{context.client.release();context.client=null;}
      }else throw Error('Schema migrations must be applied separately.');
    },
    async scope(task){return storage.run({client:null},async()=>{try{return await task();}finally{const context=storage.getStore();if(context.client){try{await context.client.query('ROLLBACK');}finally{context.client.release();}}}});},
    close:()=>pool.end()
  };
}
