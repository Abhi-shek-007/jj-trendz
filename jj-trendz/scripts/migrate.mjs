import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createPool, writeState} from '../lib/store.mjs';
import {initialProducts} from '../lib/catalog.mjs';
import {defaultCheckout, defaultHeroCopy} from '../lib/payments.mjs';

export async function migrate(client, env) {
  const mail = String(env.OWNER_EMAIL || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new Error('Set OWNER_EMAIL before migrating.');
  await client.query('BEGIN');
  try {
    await client.query(await readFile(new URL('../migrations/001-commerce.sql',import.meta.url),'utf8'));
    await client.query("SELECT id FROM shop_settings WHERE id='transaction-lock' FOR UPDATE");
    const applied = await client.query('SELECT version FROM shop_migrations WHERE version=1');
    if (!applied.rows.length) {
      const legacy = await client.query("SELECT to_regclass('public.jj_trendz_state') AS name");
      let db = legacy.rows[0].name ? (await client.query('SELECT data FROM jj_trendz_state WHERE id=1')).rows[0]?.data : null;
      db ||= {products: structuredClone(initialProducts), users:[], orders:[], inquiries:[], contact:{name:'JJ TrendZ', email:mail, phone:'', hours:'Monday – Saturday, 10 AM – 7 PM'}, bulk:{tiers:[{quantity:10,discount:5},{quantity:25,discount:10},{quantity:50,discount:15}]}};
      // Old sessions/challenges are deliberately revoked on migration.
      Object.assign(db,{sessions:{},otpChallenges:{},loginAttempts:{},otpRate:{},inquiryRate:{},requestRate:{},uploads:{},checkout:{...defaultCheckout,...db.checkout},heroCopy:{...defaultHeroCopy,...db.heroCopy}});
      if (!db.users.some(u => u.role === 'owner')) db.users.push({id:randomUUID(),name:'JJ TrendZ Owner',email:mail,role:'owner',password:null});
      for (const product of db.products) product.revision ||= 0;
      for (const order of db.orders) order.idempotencyKey ||= null;
      await writeState(client,{products:[],users:[],orders:[],inquiries:[]},db);
      await client.query('INSERT INTO shop_migrations(version) VALUES(1)');
    }
    // Owner credential recovery/rotation uses env credentials, never a browser route.
    const collision = await client.query("SELECT id FROM shop_users WHERE email=$1 AND role<>'owner'",[mail]);
    if (collision.rows.length) throw new Error('OWNER_EMAIL conflicts with a customer account. Choose a different owner email.');
    await client.query("UPDATE shop_users SET data=jsonb_set(data,'{email}',to_jsonb($1::text)) WHERE role='owner'",[mail]);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool=createPool(process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL), client=await pool.connect();
  try { await migrate(client,process.env); console.log('Database migration complete. Existing shop data preserved; legacy sessions revoked on first migration.'); }
  catch(error) { console.error('Migration failed:',error.code || error.name); process.exitCode=1; }
  finally {client.release();await pool.end();}
}
