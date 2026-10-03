import {put,del} from '@vercel/blob';
import {randomUUID} from 'node:crypto';
import {createStore} from '../lib/store.mjs';
import {handle} from '../lib/handler.mjs';
import {createMailer} from '../lib/mail.mjs';
import {sanitizeImage} from '../lib/images.mjs';
import {validateConfig,allowedOrigin,limiter,secretMatches,cleanup} from '../lib/security.mjs';

let store;
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
export default {
  async fetch(request) {
    try {
      const env=process.env;
      validateConfig(env);
      store ||= createStore();
      const url=new URL(request.url), route=(url.searchParams.get('route') || url.pathname.replace(/^\/api\//,'')).replace(/^\/+/, '');
      if(route==='maintenance') {
        if(request.method!=='GET' || !secretMatches(request.headers.get('authorization'),`Bearer ${env.CRON_SECRET}`)) return json({error:'Unauthorized.'},401);
        const result=await store.update(db=>cleanup(db));
        const {db}=await store.read();
        const used=new Set([db.heroImage,...db.products.flatMap(p=>p.images || [p.image])]);
        for(const [image,meta] of Object.entries(db.uploads || {})) {
          if(used.has(image) || meta.created > Date.now()-86400000) continue;
          // Do not accept stale upload IDs after they become eligible for collection.
          const removable=await store.update(latest=>{
            if(latest.heroImage===image || latest.products.some(p=>(p.images || [p.image]).includes(image)))return false;
            delete latest.uploads[image];return true;
          });
          if(!removable)continue;
          try {await del(image);} catch {await store.update(latest=>{latest.uploads[image]=meta;});}
        }
        return json({ok:true,...result});
      }
      if(!allowedOrigin(request,env)) return json({error:'Request origin is not allowed.'},403);
      return await handle(request,{
        ...store,production:true,secureCookies:true,otpSecret:env.OTP_SECRET,
        ownerAccess:{email:env.OWNER_EMAIL.trim().toLowerCase(),password:env.OWNER_PASSWORD},
        mailer:createMailer(env),rateLimit:limiter(store,env),
        upload:async (_path,bytes)=>{
          const image=await sanitizeImage(bytes);
          const blob=await put(image.path,image.bytes,{access:'public',contentType:image.contentType});
          try {await store.update(db=>{(db.uploads ||= {})[blob.url]={created:Date.now()};});}
          catch(error) {try {await del(blob.url);} catch {} throw error;}
          return blob.url;
        }
      });
    } catch(error) {
      const reference=randomUUID().slice(0,8);
      console.error('JJ TrendZ request failed',{reference,name:error.name,code:error.code});
      return json({error:`Unable to complete this request. Reference: ${reference}`,reference},500);
    }
  }
};
