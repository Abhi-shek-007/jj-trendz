import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
export const sessionKey = token => createHash('sha256').update(token || '').digest('hex');
export function validateConfig(env) {
  const required = ['DATABASE_URL','OWNER_EMAIL','OWNER_PASSWORD','OTP_SECRET','RESEND_API_KEY','EMAIL_FROM','APP_ORIGIN','CRON_SECRET'];
  if (required.some(key => !env[key])) throw new Error('Deployment configuration incomplete.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.OWNER_EMAIL.trim()) || env.OWNER_PASSWORD.length < 12 || env.OWNER_PASSWORD.length > 128 || env.OTP_SECRET.length < 32 || env.CRON_SECRET.length < 32) throw new Error('Invalid authentication configuration.');
  if (new URL(env.APP_ORIGIN).origin !== env.APP_ORIGIN || !env.APP_ORIGIN.startsWith('https://')) throw new Error('APP_ORIGIN must be the exact HTTPS origin.');
}
export function allowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  const allowed = new Set([env.APP_ORIGIN]);
  // System-provided deployment hostname, never the untrusted Host header.
  if (env.VERCEL_URL) allowed.add(`https://${env.VERCEL_URL}`);
  if (env.VERCEL_ENV === 'preview' && env.VERCEL_BRANCH_URL) allowed.add(`https://${env.VERCEL_BRANCH_URL}`);
  return allowed.has(new URL(request.url).origin) && (!origin || allowed.has(origin));
}
export const secretMatches = (value, expected) => !!expected && timingSafeEqual(createHash('sha256').update(value || '').digest(),createHash('sha256').update(expected).digest());
export function limiter(store, env) {
  return async (request,path) => {
    // Vercel overwrites x-vercel-forwarded-for. No client-supplied X-Forwarded-For fallback.
    const ip=request.headers.get('x-vercel-forwarded-for')?.split(',')[0].trim() || 'unknown';
    const key=createHmac('sha256',env.OTP_SECRET).update(`${ip}:${path}`).digest('hex');
    const cap=path.includes('login') || path.includes('register') || path.includes('password') ? 15 : path.includes('verify-email') ? 30 : path.includes('inquiries') ? 10 : path.includes('orders') ? 30 : 100;
    const now=Date.now(), window=15*60000;
    const limited=await store.update(db => {
      const limits=db.requestRate ||= {}, prior=limits[key];
      if (prior?.until > now && prior.count >= cap) return true;
      limits[key]={count:prior?.until > now ? prior.count+1 : 1,until:prior?.until > now ? prior.until : now+window};
      return false;
    });
    if(limited) throw Object.assign(new Error('Too many requests. Please try again later.'),{status:429});
  };
}
export function cleanup(db, now=Date.now()) {
  for (const [key,value] of Object.entries(db.sessions || {})) if (value.expires <= now) delete db.sessions[key];
  for (const [key,value] of Object.entries(db.otpChallenges || {})) if (value.expires <= now) delete db.otpChallenges[key];
  for (const name of ['requestRate','loginAttempts','otpRate','inquiryRate']) for (const [key,value] of Object.entries(db[name] || {})) if ((value.until || (value.window || 0)+3600000) <= now) delete db[name][key];
  let released=0,review=0;
  for(const order of db.orders) {
    if(!['Pending confirmation','Confirmed'].includes(order.status) || !order.reservationExpiresAt || Date.parse(order.reservationExpiresAt)>now || order.paymentStatus==='Paid') continue;
    // A QR or payment link may already have been used. Never infer failure from elapsed time.
    if(order.upiUri || order.paymentLink || order.paymentStatus==='Awaiting payment') {order.needsPaymentReview=true;review++;continue;}
    for(const item of order.items) if(item.stockReserved) {
      const product=db.products.find(p=>p.id===item.id), key=JSON.stringify([item.color,item.size]);
      if(product && Number.isInteger(product.stock?.[key])) {product.stock[key]+=item.quantity;product.revision=(product.revision||0)+1;}
      item.stockReserved=false;
    }
    order.status='Cancelled';order.paymentStatus='Cancelled';order.expiredAt=new Date(now).toISOString();released++;
  }
  return {released,review};
}
