import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../scripts/migrate.mjs';
import {createStore} from '../lib/store.mjs';

test('real Postgres engine: migration preserves legacy data, rollback, constraints and concurrent updates',async()=>{
 const database=new PGlite();
 // PGlite runs the Postgres engine in-process. One connection is queued by this pool.
 const client={query:async(sql,args)=>{if(!args && sql.includes('CREATE TABLE')) {await database.exec(sql);return {rows:[]};}return database.query(sql,args);},release(){}};
 await client.query('CREATE TABLE jj_trendz_state(id integer PRIMARY KEY,data jsonb)');
 const legacy={users:[{id:'owner',email:'old@example.test',role:'owner',name:'Owner'},{id:'buyer',email:'buyer@example.test',role:'customer',password:'hashed',name:'Buyer'}],products:[{id:'p1',name:'Saved item',price:799,stock:{'["Blue","44"]':2}}],orders:[{id:'existing',userId:'buyer',items:[{id:'p1',quantity:1,price:799}],status:'Pending confirmation'}],inquiries:[],sessions:{oldtoken:{userId:'buyer',expires:9999999999999}},contact:{name:'Real shop'},bulk:{tiers:[]}};
 await client.query('INSERT INTO jj_trendz_state VALUES(1,$1::jsonb)',[JSON.stringify(legacy)]);
 await migrate(client,{OWNER_EMAIL:'owner@example.test'});
 await migrate(client,{OWNER_EMAIL:'owner@example.test'});
 let lock=Promise.resolve();
 const pool={async connect(){let unlock;const next=new Promise(resolve=>{unlock=resolve;});const previous=lock;lock=next;await previous;return {...client,release:unlock};},end:()=>database.close()};
 const store=createStore({},pool);
 let db=(await store.read()).db;
 assert.equal(db.products[0].name,'Saved item');assert.equal(db.orders[0].items[0].price,799);assert.equal(db.users.find(u=>u.role==='owner').email,'owner@example.test');assert.deepEqual(db.sessions,{});
 const results=await Promise.allSettled([1,2,3].map(()=>store.update(state=>{const p=state.products[0];if(p.stock['["Blue","44"]']<1)throw new Error('Sold out');p.stock['["Blue","44"]']--;})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
 assert.equal((await store.read()).db.products[0].stock['["Blue","44"]'],0);
 await assert.rejects(store.update(state=>{state.products[0].stock['["Blue","44"]']=-1;}));
 assert.equal((await store.read()).db.products[0].stock['["Blue","44"]'],0);
 await store.update(state=>state.orders.push({id:'first',userId:'buyer',idempotencyKey:'unique',items:[{quantity:1,price:799}]}));
 await assert.rejects(store.update(state=>state.orders.push({id:'duplicate',userId:'buyer',idempotencyKey:'unique',items:[]})));
 assert.equal((await store.read()).db.orders.length,2);
 const original=await client.query('SELECT data FROM jj_trendz_state');assert.equal(original.rows[0].data.products[0].stock['["Blue","44"]'],2);
 await store.close();
});
