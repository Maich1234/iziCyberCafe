import { parentPort,workerData } from 'node:worker_threads';
import { PDFDocument } from 'pdf-lib';
try{
  const pdf=await PDFDocument.load(workerData,{updateMetadata:false,throwOnInvalidObject:true});
  const count=pdf.getPageCount();
  if(count<1||count>10000)throw Error('page limit');
  parentPort.postMessage({count});
}catch{parentPort.postMessage({error:true});}
