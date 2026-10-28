// Daraja adapter. Real requests are disabled unless all configuration is provided.
// Reference: https://developer.safaricom.co.ke/apis/MpesaExpressSimulate
// https://developer.safaricom.co.ke/APIs/MpesaExpressQuery
export function createMpesa(config = process.env, request = fetch) {
  if (config.MPESA_ENABLED !== '1') return null;
  const required = ['MPESA_ENV','MPESA_CONSUMER_KEY','MPESA_CONSUMER_SECRET','MPESA_SHORTCODE','MPESA_PASSKEY','MPESA_CALLBACK_BASE'];
  if (required.some(key => !config[key])) throw Error('M-Pesa configuration is incomplete.');
  if (!['sandbox','live'].includes(config.MPESA_ENV)) throw Error('Invalid M-Pesa environment.');
  const callbackBase = new URL(config.MPESA_CALLBACK_BASE);
  if (callbackBase.protocol !== 'https:' || callbackBase.username || callbackBase.password || callbackBase.search || callbackBase.hash || !['','/'].includes(callbackBase.pathname)) throw Error('M-Pesa callback base must be an HTTPS origin for the customer app.');
  if (!/^\d{5,7}$/.test(config.MPESA_SHORTCODE)) throw Error('Invalid M-Pesa shortcode.');
  const transactionType = config.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline';
  if (!['CustomerPayBillOnline','CustomerBuyGoodsOnline'].includes(transactionType)) throw Error('Invalid M-Pesa transaction type.');
  const base = config.MPESA_ENV === 'live' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  let cachedToken, tokenExpires = 0;
  async function json(url, options) {
    const res = await request(url, {...options, signal:AbortSignal.timeout(15000),redirect:'error'});
    if (!res.ok) throw Error('Payment provider is unavailable.');
    return res.json();
  }
  async function token() {
    if (cachedToken && tokenExpires > Date.now()) return cachedToken;
    const result = await json(base+'/oauth/v1/generate?grant_type=client_credentials', {headers:{Authorization:'Basic '+Buffer.from(config.MPESA_CONSUMER_KEY+':'+config.MPESA_CONSUMER_SECRET).toString('base64')}});
    if (typeof result.access_token !== 'string' || !result.access_token) throw Error('Payment authentication failed.');
    cachedToken=result.access_token;
    tokenExpires=Date.now()+Math.max(0,(Number(result.expires_in)||0)-60)*1000;
    return cachedToken;
  }
  function credentials() {
    const Timestamp = new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
    const part=key=>Timestamp.find(p=>p.type===key).value;
    const timestamp=['year','month','day','hour','minute','second'].map(part).join('');
    return {BusinessShortCode:config.MPESA_SHORTCODE,Timestamp:timestamp,Password:Buffer.from(config.MPESA_SHORTCODE+config.MPESA_PASSKEY+timestamp).toString('base64')};
  }
  async function post(path, body) {return json(base+path,{method:'POST',headers:{Authorization:'Bearer '+await token(),'Content-Type':'application/json'},body:JSON.stringify(body)});}
  return {
    environment:config.MPESA_ENV,
    async initiate({id,amount,phone}) {
      const result=await post('/mpesa/stkpush/v1/processrequest',{...credentials(),TransactionType:transactionType,Amount:amount,PartyA:phone,PartyB:config.MPESA_SHORTCODE,PhoneNumber:phone,CallBackURL:callbackBase.origin+'/api/payments/mpesa/callback/'+id,AccountReference:'IZI'+id.replaceAll('-','').slice(0,9),TransactionDesc:'Cafe service'});
      if (String(result.ResponseCode)!=='0' || !result.CheckoutRequestID || !result.MerchantRequestID) throw Error('The payment request could not be confirmed.');
      return {checkout:result.CheckoutRequestID,merchant:result.MerchantRequestID};
    },
    async query(attempt) {
      const result=await post('/mpesa/stkpushquery/v1/query',{...credentials(),CheckoutRequestID:attempt.checkout});
      if (result.CheckoutRequestID!==attempt.checkout || result.MerchantRequestID!==attempt.merchant || String(result.ResponseCode)!=='0') return 'pending';
      if (String(result.ResultCode)==='0') return 'paid';
      // Unknown results are reconciled rather than allowing another potentially duplicate charge.
      return ['1','17','1019','1032','1037','2001'].includes(String(result.ResultCode)) ? 'failed' : 'pending';
    }
  };
}
