import pg from 'pg';

// A normal Postgres connection pool works with Neon's pooled DATABASE_URL.
export function createPool(connectionString) {
  if (!connectionString) throw new Error('Database is not configured.');
  const url = new URL(connectionString);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !['require', 'verify-full'].includes(url.searchParams.get('sslmode'))) throw new Error('Database TLS is required.');
  return new pg.Pool({connectionString, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000, statement_timeout: 15000});
}
const arrays = {users:'shop_users', products:'shop_products', orders:'shop_orders', inquiries:'shop_inquiries'};
const maps = {sessions:'shop_sessions', otpChallenges:'shop_challenges', uploads:'shop_uploads'};
const rates = ['loginAttempts','otpRate','inquiryRate','requestRate'];
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);

export async function readState(client) {
  const db = {};
  for (const [key,table] of Object.entries(arrays)) db[key] = (await client.query(`SELECT id, data FROM ${table} ORDER BY id`)).rows.map(row => ({...row.data, id:row.id}));
  for (const [key,table] of Object.entries(maps)) db[key] = Object.fromEntries((await client.query(`SELECT id, data FROM ${table}`)).rows.map(row => [row.id,row.data]));
  for (const key of rates) db[key] = {};
  for (const row of (await client.query('SELECT id, data FROM shop_limits')).rows) {
    const [key,id] = JSON.parse(row.id); if (rates.includes(key)) db[key][id] = row.data;
  }
  for (const row of (await client.query("SELECT id,data FROM shop_settings WHERE id <> 'transaction-lock'")).rows) db[row.id] = row.data;
  for (const row of (await client.query('SELECT product_id,variant_key,stock FROM shop_variants')).rows) {
    const product = db.products.find(p => p.id === row.product_id); if (product) (product.stock ||= {})[row.variant_key] = row.stock;
  }
  for (const order of db.orders) order.items = [];
  for (const row of (await client.query('SELECT order_id,data FROM shop_order_items ORDER BY order_id,item_index')).rows) db.orders.find(o => o.id === row.order_id)?.items.push(row.data);
  return db;
}
const strip = (key,row) => { const value = {...row}; if (key === 'products') delete value.stock; if (key === 'orders') delete value.items; return value; };

async function syncMap(client, table, before, after) {
  for (const id of Object.keys(before)) if (!(id in after)) await client.query(`DELETE FROM ${table} WHERE id=$1`,[id]);
  for (const [id,data] of Object.entries(after)) if (!same(before[id],data)) await client.query(`INSERT INTO ${table}(id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`,[id,JSON.stringify(data)]);
}
export async function writeState(client, before, after) {
  for (const [key,table] of Object.entries(arrays)) {
    const toMap = db => Object.fromEntries((db[key] || []).map(row => [row.id,strip(key,row)]));
    await syncMap(client,table,toMap(before),toMap(after));
  }
  for (const product of after.products) {
    const old = before.products?.find(p => p.id === product.id);
    if (!same(old?.stock,product.stock)) {
      await client.query('DELETE FROM shop_variants WHERE product_id=$1',[product.id]);
      for (const [key,stock] of Object.entries(product.stock || {})) await client.query('INSERT INTO shop_variants(product_id,variant_key,stock) VALUES($1,$2,$3)',[product.id,key,stock]);
    }
    if (!same(old,product)) await client.query("INSERT INTO shop_audit(action,entity_id) VALUES('product-change',$1)",[product.id]);
  }
  for (const order of after.orders) {
    const old = before.orders?.find(o => o.id === order.id);
    if (!same(old?.items,order.items)) {
      await client.query('DELETE FROM shop_order_items WHERE order_id=$1',[order.id]);
      for (const [index,item] of order.items.entries()) await client.query('INSERT INTO shop_order_items(order_id,item_index,data) VALUES($1,$2,$3::jsonb)',[order.id,index,JSON.stringify(item)]);
    }
    if (!same(old,order)) await client.query("INSERT INTO shop_audit(action,entity_id) VALUES('order-change',$1)",[order.id]);
  }
  for (const [key,table] of Object.entries(maps)) await syncMap(client,table,before[key] || {},after[key] || {});
  const limits = db => Object.fromEntries(rates.flatMap(key => Object.entries(db[key] || {}).map(([id,data]) => [JSON.stringify([key,id]),data])));
  await syncMap(client,'shop_limits',limits(before),limits(after));
  const settings = db => Object.fromEntries(Object.entries(db).filter(([key]) => !(key in arrays) && !(key in maps) && !rates.includes(key)));
  await syncMap(client,'shop_settings',settings(before),settings(after));
}

export function createStore(env = process.env, suppliedPool) {
  const pool = suppliedPool || createPool(env.DATABASE_URL);
  async function transaction(fn, write=false) {
    const client = await pool.connect();
    try {
      await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      if (write) await client.query("SELECT id FROM shop_settings WHERE id='transaction-lock' FOR UPDATE");
      const db = await readState(client);
      if (!db.contact) throw new Error('Run the database migration before starting this deployment.');
      const before = structuredClone(db);
      const result = fn(db);
      if (result instanceof Promise) throw new Error('Store mutations must be synchronous.');
      if (write) await writeState(client,before,db);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  return {read: () => transaction(db => ({db})), update: fn => transaction(fn,true), close: () => pool.end()};
}
