import test from 'node:test';
import assert from 'node:assert/strict';
import {scryptSync,randomBytes} from 'node:crypto';
import {handle} from '../lib/handler.mjs';
import {limiter,cleanup,sessionKey,allowedOrigin,validateConfig} from '../lib/security.mjs';
import {defaultCheckout,defaultHeroCopy} from '../lib/payments.mjs';
import {sanitizeImage} from '../lib/images.mjs';
import sharp from 'sharp';

const env={OWNER_EMAIL:'owner@example.test',OWNER_PASSWORD:'test-owner-password-123',OTP_SECRET:'test-secret-'.repeat(4),APP_ORIGIN:'https://shop.test',CRON_SECRET:'cron-'.repeat(10),DATABASE_URL:'postgres://test',RESEND_API_KEY:'fake',EMAIL_FROM:'JJ <shop@example.test>'};
const product={id:'p1',name:'Blue bangles',caption:'A pair',price:799,oldPrice:0,category:'Bangles',collection:'Everyday',colors:['Blue'],sizes:['44'],stock:{'["Blue","44"]':3},images:['/assets/bangles.jpg'],image:'/assets/bangles.jpg',revision:0};
function fixture() {
 const salt=randomBytes(16).toString('hex');
 let state={users:[{id:'owner',name:'Owner',role:'owner',email:env.OWNER_EMAIL,password:null}],products:[structuredClone(product)],orders:[],inquiries:[],sessions:{},contact:{email:env.OWNER_EMAIL},bulk:{tiers:[]},checkout:defaultCheckout,heroCopy:defaultHeroCopy};
 let pending=Promise.resolve();const messages=[];
 const store={read:async()=>({db:structuredClone(state)}),update(fn){const result=pending.then(()=>{const draft=structuredClone(state),value=fn(draft);state=draft;return value;});pending=result.catch(()=>{});return result;}};
 const dependencies={...store,production:true,secureCookies:true,otpSecret:env.OTP_SECRET,ownerAccess:{email:env.OWNER_EMAIL,password:env.OWNER_PASSWORD},mailer:{send:async msg=>messages.push(msg)},upload:async()=>`https://shop.public.blob.vercel-storage.com/${randomBytes(8).toString('hex')}.webp`,rateLimit:limiter(store,env)};
 async function call(path,body,cookie,method=body?'POST':'GET',origin=env.APP_ORIGIN) {
  const response=await handle(new Request(env.APP_ORIGIN+'/api/'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined}),dependencies);
  return {status:response.status,data:response.headers.get('content-type')?.includes('json')?await response.json():await response.text(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
 }
 async function authenticate(owner=false,email='buyer@example.test') {
  const challenge=await call(owner?'login':'register',owner?{email:env.OWNER_EMAIL,password:env.OWNER_PASSWORD,role:'owner'}:{name:'Buyer',email,password:'test-customer-password'});
  assert.equal(challenge.status,200,JSON.stringify(challenge.data));assert(challenge.data.challengeId);assert(!challenge.cookie);
  const code=messages.at(-1).text.match(/code is (\d{6})/)[1];
  const verified=await call('verify-email',{challengeId:challenge.data.challengeId,code});assert.equal(verified.status,200,JSON.stringify(verified.data));return verified.cookie;
 }
 return {store,call,authenticate,messages,dependencies};
}

test('owner and customer OTP, hashed sessions, permissions and origin checks',async()=>{
 const f=fixture(),owner=await f.authenticate(true),customer=await f.authenticate();
 const state=(await f.store.read()).db;
 assert(state.sessions[sessionKey(owner.split('=')[1])]);assert(!state.sessions[owner.split('=')[1]]);
 assert.equal((await f.call('owner',null,customer)).status,403);
 assert.equal((await f.call('owner',null,owner)).status,200);
 assert.equal((await f.call('settings',{contact:{name:'bad'}},owner,'POST','https://attacker.test')).status,403);
 f.dependencies.ownerAccess.password='rotated-owner-password-123';
 assert.equal((await f.call('owner',null,owner)).status,403);
 assert.equal((await f.call('orders')).status,401);
});

test('checkout retries, concurrent last-item orders, stale edits, isolation and cancellation',async()=>{
 const f=fixture(),owner=await f.authenticate(true),customer=await f.authenticate(),other=await f.authenticate(false,'other@example.test');
 const body={items:[{id:'p1',color:'Blue',size:'44',quantity:2}],phone:'9876543210',pincode:'600001',address:'123 Test Street',idempotencyKey:'checkout-one-00000001'};
 const order=await f.call('orders',body,customer);assert.equal(order.status,201,JSON.stringify(order.data));assert.equal(order.data.order.payableTotal,1598);
 const repeat=await f.call('orders',body,customer);assert.equal(repeat.data.order.id,order.data.order.id);
 assert.equal((await f.call('orders',{...body,address:'changed'},customer)).status,409);
 assert.equal((await f.call('orders',null,other)).data.orders.length,0);
 assert.equal((await f.call('orders/'+order.data.order.id+'/qr',null,other)).status,404);
 assert.equal((await f.call('products',{...product,stock:{'["Blue","44"]':3}},owner)).status,409);
 const outcomes=await Promise.all(['a','b'].map(x=>f.call('orders',{...body,items:[{...body.items[0],quantity:1}],idempotencyKey:'last-item-request-'+x},customer)));
 assert.deepEqual(outcomes.map(r=>r.status).sort(),[201,409]);
 assert.equal((await f.call('orders/'+order.data.order.id,{action:'cancel'},owner,'PATCH')).status,400);
 assert.equal((await f.call('orders/'+order.data.order.id,{action:'cancel',reconciled:true},owner,'PATCH')).status,200);
 await f.call('orders/'+order.data.order.id,{action:'cancel',reconciled:true},owner,'PATCH');
 assert.equal((await f.store.read()).db.products[0].stock['["Blue","44"]'],2);
});

test('owner uploads are registered; unrelated URLs and malformed photos are rejected',async()=>{
 const f=fixture(),owner=await f.authenticate(true);
 const bytes=await sharp({create:{width:10,height:10,channels:3,background:'blue'}}).png().toBuffer();
 assert.equal((await f.call('uploads',{image:'data:image/png;base64,'+bytes.toString('base64')})).status,403);
 const upload=await f.call('uploads',{image:'data:image/png;base64,'+bytes.toString('base64')},owner);assert.equal(upload.status,200);
 assert.equal((await f.call('products',{...product,images:[upload.data.image]},owner)).status,200);
 assert.equal((await f.call('products',{...product,revision:1,images:['https://attacker.test/image.jpg']},owner)).status,400);
 const safe=await sanitizeImage(bytes);assert.equal((await sharp(safe.bytes).metadata()).format,'webp');
 await assert.rejects(sanitizeImage(Buffer.from([255,216,255,224,1,2,3,4,5,6,7,8,9,10])),/valid JPG/);
});

test('atomic inquiry limits and failed email retain a visible inquiry',async()=>{
 const f=fixture();f.dependencies.mailer.send=async()=>{throw new Error('outage');};
 const payload={name:'Buyer',email:'buyer@example.test',message:'Is this available?'};
 const responses=await Promise.all([f.call('inquiries',payload),f.call('inquiries',payload)]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,429]);
 assert.equal((await f.store.read()).db.inquiries.length,1);
 assert.equal(responses.find(r=>r.status===200).data.emailSent,false);
});

test('shared IP limits persist and maintenance never releases possibly paid stock',async()=>{
 const f=fixture();
 for(let i=0;i<15;i++) assert.equal((await f.call('login',{email:`fake${i}@example.test`,password:'wrong'})).status,401);
 assert.equal((await f.call('login',{email:'fresh@example.test',password:'wrong'})).status,429);
 await f.store.update(db=>{db.sessions.expired={expires:1};db.orders=[{id:'quoted',status:'Confirmed',paymentStatus:'Awaiting payment',upiUri:'upi://pay',reservationExpiresAt:new Date(0).toISOString(),items:[]},{id:'unquoted',status:'Pending confirmation',paymentStatus:'Awaiting quote',reservationExpiresAt:new Date(0).toISOString(),items:[{id:'p1',color:'Blue',size:'44',stockReserved:true,quantity:1}]}];});
 await f.store.update(db=>cleanup(db));await f.store.update(db=>cleanup(db));
 const state=(await f.store.read()).db;
 assert(!state.sessions.expired);assert(state.orders[0].needsPaymentReview);assert.equal(state.orders[1].status,'Cancelled');assert.equal(state.products[0].stock['["Blue","44"]'],4);
 assert(allowedOrigin(new Request('https://shop.test/api/me'),env));assert(!allowedOrigin(new Request('https://evil.test/api/me'),env));
 assert.doesNotThrow(()=>validateConfig(env));assert.throws(()=>validateConfig({...env,OTP_SECRET:'short'}));
});

test('OTP attempts, replay and customer recovery revoke previous sessions',async()=>{
 const f=fixture(),customer=await f.authenticate();
 const reset=await f.call('reset-password',{email:'buyer@example.test',password:'new-secure-password'});
 const code=f.messages.at(-1).text.match(/code is (\d{6})/)[1];
 const wrong=code==='000000'?'111111':'000000';
 assert.equal((await f.call('verify-email',{challengeId:reset.data.challengeId,code:wrong})).status,400);
 const verified=await f.call('verify-email',{challengeId:reset.data.challengeId,code});assert.equal(verified.status,200);
 assert.equal((await f.call('me',null,customer)).data.user,null);
 assert.equal((await f.call('verify-email',{challengeId:reset.data.challengeId,code})).status,400);
 assert.equal((await f.call('login',{email:'buyer@example.test',password:'test-customer-password'})).status,401);
 assert.equal((await f.call('login',{email:'buyer@example.test',password:'new-secure-password'})).status,200);
});
