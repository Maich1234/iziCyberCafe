import { PDFDocument } from 'pdf-lib';
export async function pdfBytes(name='document',pages=1){const doc=await PDFDocument.create();doc.setTitle(name);for(let i=0;i<pages;i++)doc.addPage([595,842]);return Buffer.from(await doc.save({useObjectStreams:false}));}
export async function pdfBase64(name,pages){return (await pdfBytes(name,pages)).toString('base64');}
