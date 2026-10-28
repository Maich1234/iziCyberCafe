import { receiptData, receiptText } from '../public/receipt-printer.js';

export function receiptDownload({db,path,req,res,user,surface,fail}) {
  const match=path.match(/^\/api\/orders\/([1-9]\d*)\/receipt$/);
  if (!match) return false;
  if (req.method!=='GET' || surface!=='customer' || user?.role!=='customer') fail('Not found',404);
  const order=db.prepare('SELECT orders.*,cafes.name AS cafe,services.name AS service FROM orders JOIN cafes ON cafes.id=orders.cafe_id JOIN services ON services.id=orders.service_id WHERE orders.id=? AND customer_id=?').get(Number(match[1]),user.id);
  if (!order) fail('Not found',404);
  const payment=db.prepare('SELECT id,amount,environment,created FROM payments WHERE order_id=?').get(order.id);
  const receipt=receiptData(order,payment);
  if (!receipt) fail('A receipt is available after verified payment.',409);
  res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="${receipt.reference}.txt"`,'Cache-Control':'no-store'});
  res.end(receiptText(receipt));
  return true;
}
