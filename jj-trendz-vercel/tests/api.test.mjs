import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, scryptSync} from 'node:crypto';
import {handle} from '../lib/handler.mjs';
import {initialProducts} from '../lib/catalog.mjs';
import {createStore} from '../lib/store.mjs';

const ownerPassword = 'test-owner-password-123';
const salt = randomBytes(16).toString('hex');
const owner = {id: 'owner', name: 'JJ TrendZ Owner', email: 'owner@example.test', password: `${salt}:${scryptSync(ownerPassword, salt, 64).toString('hex')}`, role: 'owner'};

function testStore() {
  let state = {
    products: structuredClone(initialProducts), users: [owner], sessions: {}, loginAttempts: {}, inquiries: [], orders: [],
    contact: {name: 'JJ TrendZ', email: '', phone: '', hours: 'Monday – Saturday, 10 AM – 7 PM'},
    bulk: {tiers: [{quantity: 10, discount: 5}, {quantity: 25, discount: 10}]}
  };
  return {
    read: async () => ({db: structuredClone(state)}),
    update: async change => {
      const draft = structuredClone(state);
      const result = change(draft);
      state = draft;
      return result;
    },
    upload: async (path, bytes, type) => {
      assert(bytes.length > 12);
      assert.equal(type, 'image/jpeg');
      return `https://example.public.blob.vercel-storage.com/${path}`;
    }
  };
}

async function call(store, path, method = 'GET', body, cookie) {
  const response = await handle(new Request(`https://jj-trendz.vercel.app${path}`, {
    method,
    headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(cookie ? {Cookie: cookie} : {})},
    body: body ? JSON.stringify(body) : undefined
  }), store);
  return {status: response.status, cookie: response.headers.get('set-cookie'), data: await response.json()};
}

test('owner upload, bulk pricing, customer orders and role protection work across requests', async () => {
  const store = testStore();
  assert.equal((await call(store, '/api/owner')).status, 403);
  const login = await call(store, '/api/login', 'POST', {email: owner.email, password: ownerPassword, role: 'owner'});
  assert.equal(login.status, 200);
  assert.match(login.cookie, /HttpOnly; SameSite=Strict; Secure/);
  const ownerCookie = login.cookie.split(';')[0];

  const jpeg = Buffer.from([255, 216, 255, 224, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const created = await call(store, '/api/products', 'POST', {
    name: 'Test bangles', caption: 'Gold tone', price: 1000, oldPrice: 1200,
    category: 'Bangles', collection: 'Festive', image: `data:image/jpeg;base64,${jpeg.toString('base64')}`
  }, ownerCookie);
  assert.equal(created.status, 200);
  assert.equal(created.data.size, 'Free size');
  assert.match(created.data.image, /\.public\.blob\.vercel-storage\.com/);
  assert.equal((await call(store, '/api/catalog')).data.products.find(item => item.id === created.data.id).image, created.data.image);
  assert.equal((await call(store, '/api/products', 'POST', {
    name: 'No access', caption: 'No access', price: 1000,
    category: 'Bangles', collection: 'Festive', image: `data:image/jpeg;base64,${jpeg.toString('base64')}`
  })).status, 403);

  const registered = await call(store, '/api/register', 'POST', {name: 'A Customer', email: 'customer@example.test', password: 'customer-pass-123'});
  assert.equal(registered.status, 200);
  const customerCookie = registered.cookie.split(';')[0];
  assert.equal((await call(store, '/api/owner', 'GET', undefined, customerCookie)).status, 403);
  const order = await call(store, '/api/orders', 'POST', {
    items: [{id: created.data.id, quantity: 10}], address: '123 Main Street', phone: '1234567890'
  }, customerCookie);
  assert.equal(order.status, 201);
  assert.equal(order.data.order.subtotal, 10000);
  assert.equal(order.data.order.discount, 5);
  assert.equal(order.data.order.total, 9500);
  assert.equal(order.data.order.items[0].size, 'Free size');

  assert.equal((await call(store, `/api/orders/${order.data.order.id}`, 'PATCH', {status: 'Confirmed'}, customerCookie)).status, 403);
  assert.equal((await call(store, `/api/orders/${order.data.order.id}?route=orders/${order.data.order.id}`, 'PATCH', {status: 'Confirmed'}, ownerCookie)).status, 200);
  assert.equal((await call(store, '/api/orders', 'GET', undefined, customerCookie)).data.orders[0].status, 'Confirmed');
  assert.equal((await call(store, '/api/password', 'POST', {current: ownerPassword, password: 'changed-owner-password-456'}, ownerCookie)).status, 200);
  assert.equal((await call(store, '/api/login', 'POST', {email: owner.email, password: ownerPassword, role: 'owner'})).status, 401);
  assert.equal((await call(store, '/api/login', 'POST', {email: owner.email, password: 'changed-owner-password-456', role: 'owner'})).status, 200);
});

test('bad credentials are rate limited and database setup requires private environment variables', async () => {
  const store = testStore();
  for (let i = 0; i < 12; i++) assert.equal((await call(store, '/api/login', 'POST', {email: owner.email, password: 'wrong', role: 'owner'})).status, 401);
  assert.equal((await call(store, '/api/login', 'POST', {email: owner.email, password: ownerPassword, role: 'owner'})).status, 429);
  assert.throws(() => createStore({DATABASE_URL: 'postgresql://example', OWNER_EMAIL: 'owner@example.test', OWNER_PASSWORD: 'short'}), /OWNER_PASSWORD/);
});
