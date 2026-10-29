import { Worker } from 'node:worker_threads';
export const PAPERS=['A4','Letter','A3','Legal'];
export const PAPER_TYPES=['plain','premium','photo'];
const invalid=message=>Object.assign(new Error(message),{status:400});
export async function countPages(bytes){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./pdf-counter.js',import.meta.url),{workerData:bytes,resourceLimits:{maxOldGenerationSizeMb:96,maxYoungGenerationSizeMb:16}});
    let settled=false;
    const finish=(count)=>{if(settled)return;settled=true;clearTimeout(timer);worker.terminate();if(count)resolve(count);else reject(invalid('Upload a readable, unencrypted PDF with 1–10,000 pages.'));};
    const timer=setTimeout(()=>finish(),8000);
    worker.once('message',result=>finish(result.count));worker.once('error',()=>finish());worker.once('exit',()=>finish());
  });
}
export function pageSelection(input,count){
  if(!Number.isSafeInteger(count)||count<1||count>10000)throw invalid('Re-upload the PDF so its pages can be counted.');
  const raw=String(input||'all').trim();
  if(raw==='all'||!raw)return {ranges:`1-${count}`,count};
  if(raw.length>500||!/^\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*$/.test(raw))throw invalid('Use page ranges such as 1-3,5,8-10.');
  const selected=new Set();
  for(const part of raw.split(',')){
    const [a,b=a]=part.trim().split('-').map(Number);
    if(a<1||a>b||b>count)throw invalid('Page ranges must fit this PDF.');
    for(let i=a;i<=b;i++)selected.add(i);
  }
  const pages=[...selected].sort((a,b)=>a-b),ranges=[];
  for(let i=0;i<pages.length;i++){const a=pages[i];while(pages[i+1]===pages[i]+1)i++;ranges.push(a===pages[i]?String(a):a+'-'+pages[i]);}
  return {ranges:ranges.join(','),count:pages.length};
}
export function validateRates(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw invalid('Enter the printing charges.');
  const result={};
  for(const key of ['mono','colour_extra','duplex_extra']){if(!Number.isSafeInteger(input[key])||input[key]<0||input[key]>100000)throw invalid('Charges must be whole Kenya shillings, from 0 to 100,000.');result[key]=input[key];}
  result.paper={};
  for(const size of PAPERS)if(input.paper?.[size]){
    result.paper[size]={};
    for(const type of PAPER_TYPES)if(input.paper[size][type]!==undefined){const rate=input.paper[size][type];if(!Number.isSafeInteger(rate)||rate<0||rate>100000)throw invalid('Enter valid paper charges.');result.paper[size][type]=rate;}
  }
  if(!Object.values(result.paper).some(r=>Object.keys(r).length))throw invalid('Price at least one paper size and type.');
  return result;
}
export function estimatePrint(service,options){
  if(!service.rates)return null;
  const rates=JSON.parse(service.rates),stock=rates.paper?.[options.paper]?.[options.paper_type];
  if(stock===undefined)throw invalid('This paper size or type is unavailable for this service.');
  const pages=options.selected_pages*options.copies;
  const sheets=Math.ceil(options.selected_pages/(options.sides==='one-sided'?1:2))*options.copies;
  const result={pages,sheets,base:service.price,printing:pages*rates.mono,colour:options.color==='color'?pages*rates.colour_extra:0,paper:sheets*stock,duplex:options.sides==='one-sided'?0:sheets*rates.duplex_extra};
  result.total=result.base+result.printing+result.colour+result.paper+result.duplex;
  if(!Number.isSafeInteger(result.total)||result.total<1||result.total>10000000)throw invalid('This job exceeds the supported quote amount.');
  return result;
}
