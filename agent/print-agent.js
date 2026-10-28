// CUPS bridge: https://www.cups.org/doc/man-lp.html
// No shell interpolation and no implicit submission retries.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, mkdirSync, openSync, fsyncSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const execute=promisify(execFile);
export function cupsArguments(printer,job,file) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(printer) || !Number.isSafeInteger(job.copies) || job.copies<1 || job.copies>100 || !['A4','Letter'].includes(job.paper) || !['monochrome','color'].includes(job.color) || !['one-sided','two-sided-long-edge'].includes(job.sides)) throw Error('Invalid printer or job settings.');
  return ['-d',printer,'-n',String(job.copies),'-o','media='+job.paper,'-o','sides='+job.sides,'-o','print-color-mode='+job.color,'-t','iziCyberCafe-'+job.id,file];
}
export async function runOnce(config, {request=fetch, submit=async(args)=>execute('lp',args,{timeout:60000,env:{...process.env,LC_ALL:'C'}})}={}) {
  if(config.PRINT_ENABLE!=='1') throw Error('Set PRINT_ENABLE=1 on the shop computer to allow printing.');
  if(!/^[a-f0-9]{64}$/.test(config.PRINT_AGENT_TOKEN||'') || !['sandbox','live'].includes(config.PRINT_PAYMENT_ENV)) throw Error('Configure a printer token and payment environment.');
  const base=new URL(config.PRINT_API_ORIGIN);
  if(base.protocol!=='https:' && !(base.protocol==='http:' && ['localhost','127.0.0.1'].includes(base.hostname))) throw Error('Use HTTPS for the café workspace.');
  if(base.username||base.password||base.search||base.hash||!['','/'].includes(base.pathname))throw Error('Use the café origin without a path or credentials.');
  const headers={Authorization:'Bearer '+config.PRINT_AGENT_TOKEN};
  async function call(path,body,claim) {
    const response=await request(base.origin+path,{method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'}),...(claim?{'X-Print-Claim':claim}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000),redirect:'error'});
    if(!response.ok)throw Error('Print API request failed: '+response.status);return response;
  }
  const {job,attention}=await (await call('/api/print-agent/claim',{})).json();
  if(!job)return {status:attention?'attention':'idle'};
  const report=(body)=>call(`/api/print-agent/jobs/${job.id}/report`,body,job.claim_token);
  let directory;
  try {
    if(job.environment!==config.PRINT_PAYMENT_ENV) throw Error('The job payment environment does not match this agent.');
    const bytes=Buffer.from(await (await call(`/api/print-agent/jobs/${job.id}/file`,undefined,job.claim_token)).arrayBuffer());
    if(bytes.length>3*1024*1024 || bytes.subarray(0,5).toString()!=='%PDF-' || createHash('sha256').update(bytes).digest('hex')!==job.sha256) throw Error('The print file failed integrity checks.');
    directory=mkdtempSync(join(tmpdir(),'izi-print-'));
    const file=join(directory,'document.pdf');writeFileSync(file,bytes,{mode:0o600});
    const args=cupsArguments(config.PRINT_CUPS_PRINTER||'',job,file);
    const journal=resolve(config.PRINT_JOURNAL_DIR||'data/print-agent');mkdirSync(journal,{recursive:true,mode:0o700});
    // Fsync before calling the spooler. A crash/uncertain response requires staff reconciliation.
    const fd=openSync(join(journal,`${job.id}-${job.attempt}.json`),'wx',0o600);
    try{writeFileSync(fd,JSON.stringify({job:job.id,attempt:job.attempt,phase:'submission_started'}));fsyncSync(fd);}finally{closeSync(fd);}
    const {stdout}=await submit(args);
    const spool=String(stdout).match(/request id is ([A-Za-z0-9_.-]+)/)?.[1];
    if(!spool)throw Error('The spooler outcome is uncertain.');
    // Reporting failure does not cause another lp invocation. The claimed job remains for review.
    await report({status:'spooled',spool_id:spool});return {status:'spooled',job:job.id};
  } catch(error) {
    try{await report({status:'uncertain'});}catch{}
    throw error;
  } finally {if(directory)rmSync(directory,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  do {
    try{console.log(await runOnce(process.env));}catch(error){console.error(error.message);if(process.argv.includes('--once'))process.exitCode=1;}
    if(process.argv.includes('--once'))break;
    await new Promise(resolve=>setTimeout(resolve,5000));
  }while(true);
}
