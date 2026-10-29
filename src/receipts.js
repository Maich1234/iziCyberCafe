import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { receiptData, receiptText } from '../public/receipt-printer.js';

export async function receiptDownload({db,path,req,res,user,surface,fail}) {
  const match=path.match(/^\/api\/orders\/([1-9]\d*)\/receipt(?:\.(pdf))?$/);
  if (!match) return false;
  if (req.method!=='GET' || surface!=='customer' || user?.role!=='customer') fail('Not found',404);
  const order=(await db.prepare('SELECT orders.*,cafes.name AS cafe,services.name AS service FROM orders JOIN cafes ON cafes.id=orders.cafe_id JOIN services ON services.id=orders.service_id WHERE orders.id=? AND customer_id=?').get(Number(match[1]),user.id));
  if (!order) fail('Not found',404);
  const payment=(await db.prepare('SELECT id,amount,environment,created FROM payments WHERE order_id=?').get(order.id));
  const receipt=receiptData(order,payment);
  if (!receipt) fail('A receipt is available after verified payment.',409);
  const state=`Order status: ${order.status}\nRefund: ${order.refund_state==='pending'?'Pending support reconciliation':order.refund_state==='recorded'?'External refund recorded by support':'No refund recorded'}`;
  if(match[2]==='pdf'){
    const doc=await PDFDocument.create(),page=doc.addPage([420,595]),font=await doc.embedFont(StandardFonts.Helvetica);
    const lines=(receiptText(receipt)+'\n'+state+'\nPayment record. Not a tax invoice.').replace(/[^\x20-\x7e\n]/g,' ').split('\n');
    let y=550;
    for(const line of lines)for(let i=0;i<Math.max(1,line.length);i+=65){if(y<35)break;page.drawText(line.slice(i,i+65),{x:30,y,size:10,font,color:rgb(0.08,0.1,0.1)});y-=17;}
    res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${receipt.reference}.pdf"`,'Cache-Control':'no-store'});res.end(Buffer.from(await doc.save()));return true;
  }
  res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="${receipt.reference}.txt"`,'Cache-Control':'no-store'});
  res.end(receiptText(receipt)+'\n'+state);
  return true;
}
