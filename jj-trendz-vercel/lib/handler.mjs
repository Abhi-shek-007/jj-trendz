import {randomBytes, randomUUID, scryptSync, timingSafeEqual} from 'node:crypto';

const clean = (value, max = 1500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const safeUser = user => user ? {id: user.id, name: user.name, email: user.email, role: user.role} : null;
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const hash = password => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; };
const verify = (password, stored) => {
  try {
    const [salt, expected] = stored.split(':');
    const actual = scryptSync(password, salt, 64);
    const bytes = Buffer.from(expected, 'hex');
    return bytes.length === actual.length && timingSafeEqual(actual, bytes);
  } catch { return false; }
};
const reply = (data, status = 200, cookie) => Response.json(data, {
  status,
  headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(cookie ? {'Set-Cookie': cookie} : {})}
});

function imageFromDataUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('data:')) return null;
  const match = value.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) fail(400, 'Choose a JPG, PNG or WebP image.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length < 12 || bytes.length > 2 * 1024 * 1024) fail(400, 'Choose an image under 2 MB.');
  const kind = match[1];
  const valid = kind === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216
    : kind === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) fail(400, 'Invalid image file.');
  return {bytes, kind, extension: kind === 'jpeg' ? 'jpg' : kind};
}

export async function handle(request, {read, update, upload}) {
  try {
    const url = new URL(request.url);
    const route = url.searchParams.get('route') || url.pathname.replace(/^\/api\//, '');
    const path = '/api/' + route.replace(/^\/+/, '');
    const method = request.method.toUpperCase();
    if (request.headers.get('origin') && new URL(request.headers.get('origin')).host !== url.host) fail(403, 'Request origin is not allowed.');
    const cookie = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith('jj_session='))?.slice(11);
    const currentUser = db => {
      const session = cookie && db.sessions[cookie];
      return session?.expires > Date.now() ? db.users.find(user => user.id === session.userId) : null;
    };
    const owner = db => { const user = currentUser(db); if (user?.role !== 'owner') fail(403, 'Owner access is required.'); return user; };
    const customer = db => { const user = currentUser(db); if (user?.role !== 'customer') fail(user ? 403 : 401, 'Sign in with a customer account to place your order.'); return user; };
    let input = {};
    if (!['GET', 'HEAD'].includes(method)) {
      if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, 'Send JSON data.');
      const body = await request.text();
      if (body.length > 3 * 1024 * 1024) fail(413, 'Upload is too large.');
      try { input = JSON.parse(body || '{}'); } catch { fail(400, 'Invalid JSON.'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Send a JSON object.');
    }

    if (path === '/api/catalog' && method === 'GET') {
      const {db} = await read();
      return reply({products: db.products, contact: db.contact, bulk: db.bulk});
    }
    if (path === '/api/me' && method === 'GET') {
      const {db} = await read();
      return reply({user: safeUser(currentUser(db))});
    }
    if (path === '/api/register' && method === 'POST') {
      const name = clean(input.name, 60), mail = clean(input.email, 150).toLowerCase();
      if (!name || !validEmail(mail) || typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) fail(400, 'Enter your name, a valid email and a password of 8–128 characters.');
      const result = await update(db => {
        if (db.users.some(user => user.email === mail)) fail(409, 'This email is already registered. Sign in instead.');
        const user = {id: randomUUID(), name, email: mail, password: hash(input.password), role: 'customer'};
        const token = randomBytes(32).toString('hex');
        db.users.push(user);
        db.sessions[token] = {userId: user.id, expires: Date.now() + 7 * 86400000};
        return {user: safeUser(user), token};
      });
      return reply({user: result.user}, 200, `jj_session=${result.token}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=604800`);
    }
    if (path === '/api/login' && method === 'POST') {
      const mail = clean(input.email, 150).toLowerCase();
      const result = await update(db => {
        const now = Date.now();
        const attempts = db.loginAttempts ||= {};
        for (const [key, value] of Object.entries(attempts)) if (value.until < now) delete attempts[key];
        const recent = attempts[mail];
        if (recent?.count >= 12 && recent.until > now) fail(429, 'Too many login attempts. Try again in 15 minutes.');
        const user = db.users.find(item => item.email === mail);
        if (!user || typeof input.password !== 'string' || input.password.length > 128 || !verify(input.password, user.password) || user.role !== (input.role === 'owner' ? 'owner' : 'customer')) {
          attempts[mail] = {count: (recent?.count || 0) + 1, until: recent?.until > now ? recent.until : now + 900000};
          return {failed: true};
        }
        delete attempts[mail];
        const token = randomBytes(32).toString('hex');
        db.sessions[token] = {userId: user.id, expires: now + 7 * 86400000};
        return {user: safeUser(user), token};
      });
      if (result.failed) fail(401, 'Email or password is incorrect.');
      return reply({user: result.user}, 200, `jj_session=${result.token}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=604800`);
    }
    if (path === '/api/logout' && method === 'POST') {
      await update(db => { delete db.sessions[cookie]; });
      return reply({ok: true}, 200, 'jj_session=; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=0');
    }
    if (path === '/api/password' && method === 'POST') {
      await update(db => {
        const user = currentUser(db);
        if (!user) fail(401, 'Sign in to change your password.');
        if (typeof input.current !== 'string' || !verify(input.current, user.password)) fail(400, 'Current password is incorrect.');
        if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) fail(400, 'Use a password of 8–128 characters.');
        user.password = hash(input.password);
        for (const [token, session] of Object.entries(db.sessions)) if (session.userId === user.id && token !== cookie) delete db.sessions[token];
      });
      return reply({ok: true});
    }
    if (path === '/api/owner' && method === 'GET') {
      const {db} = await read(); owner(db);
      return reply({inquiries: db.inquiries, orders: db.orders});
    }
    if (path === '/api/products' && method === 'POST') {
      const name = clean(input.name, 100), caption = clean(input.caption);
      const price = Number(input.price), oldPrice = Number(input.oldPrice || 0);
      if (!name || !caption || !Number.isInteger(price) || price < 1 || price > 999999 || !Number.isFinite(oldPrice) || oldPrice < 0 || oldPrice > 999999) fail(400, 'Provide a name, caption and valid prices.');
      if (!['Necklaces', 'Earrings', 'Bridal Sets', 'Bangles'].includes(input.category) || !['Everyday', 'Occasion', 'Festive'].includes(input.collection)) fail(400, 'Choose a valid category and collection.');
      const file = imageFromDataUrl(input.image);
      const {db} = await read(); owner(db);
      const previous = db.products.find(product => product.id === input.id);
      if (!file && !previous) fail(400, 'Upload a product photograph.');
      const uploadedUrl = file ? await upload(`products/${randomUUID()}.${file.extension}`, file.bytes, `image/${file.kind}`) : null;
      const product = await update(latest => {
        owner(latest);
        const old = latest.products.find(item => item.id === input.id);
        if (input.id && !old) fail(404, 'Product not found.');
        const image = uploadedUrl || old?.image;
        if (!image) fail(400, 'Upload a product photograph.');
        const item = {id: old?.id || randomUUID(), name, caption, price, oldPrice, category: input.category, collection: input.collection, badge: clean(input.badge, 40), image, ...(['Necklaces', 'Bangles'].includes(input.category) ? {size: 'Free size'} : {})};
        if (old) latest.products = latest.products.map(value => value.id === old.id ? item : value);
        else latest.products.push(item);
        return item;
      });
      return reply(product);
    }
    if (path.startsWith('/api/products/') && method === 'DELETE') {
      const id = path.split('/').pop();
      await update(db => { owner(db); db.products = db.products.filter(product => product.id !== id); });
      return reply({ok: true});
    }
    if (path === '/api/settings' && method === 'POST') {
      const c = input.contact;
      if (!c || !clean(c.name, 80) || (c.email && !validEmail(c.email)) || (c.phone && !/^\+?[0-9 ()-]{7,20}$/.test(c.phone))) fail(400, 'Provide valid contact details.');
      await update(db => { owner(db); db.contact = {name: clean(c.name, 80), email: clean(c.email, 150), phone: clean(c.phone, 30), hours: clean(c.hours, 120)}; });
      return reply({ok: true});
    }
    if (path === '/api/bulk' && method === 'POST') {
      if (!Array.isArray(input.tiers) || input.tiers.length > 5) fail(400, 'Use up to five discount tiers.');
      const tiers = input.tiers.map(tier => ({quantity: Number(tier.quantity), discount: Number(tier.discount)})).sort((a, b) => a.quantity - b.quantity);
      if (tiers.some((tier, i) => !Number.isInteger(tier.quantity) || tier.quantity < 2 || tier.quantity > 9999 || !Number.isFinite(tier.discount) || tier.discount < 0 || tier.discount > 80 || (i && tier.quantity === tiers[i - 1].quantity))) fail(400, 'Use unique minimum quantities from 2–9999 and discounts from 0–80%.');
      await update(db => { owner(db); db.bulk = {tiers}; });
      return reply({tiers});
    }
    if (path === '/api/inquiries' && method === 'POST') {
      if (!clean(input.name, 60) || !validEmail(input.email) || !clean(input.message, 2000)) fail(400, 'Enter your name, email and question.');
      await update(db => {
        db.inquiries.push({id: randomUUID(), name: clean(input.name, 60), email: clean(input.email, 150), message: clean(input.message, 2000), productNames: (Array.isArray(input.ids) ? input.ids : []).map(id => db.products.find(product => product.id === id)?.name).filter(Boolean).join(', '), created: new Date().toISOString()});
      });
      return reply({ok: true});
    }
    if (path === '/api/orders' && method === 'GET') {
      const {db} = await read(); const user = customer(db);
      return reply({orders: db.orders.filter(order => order.userId === user.id)});
    }
    if (path === '/api/orders' && method === 'POST') {
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) fail(400, 'Add products to your order.');
      if (!clean(input.address, 500) || !clean(input.phone, 30)) fail(400, 'Provide your contact number and delivery address.');
      const order = await update(db => {
        const user = customer(db), seen = new Set();
        const items = input.items.map(entry => {
          const product = db.products.find(item => item.id === entry.id);
          if (!product || !Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 9999 || seen.has(entry.id)) fail(400, 'Check your products and quantities.');
          seen.add(entry.id);
          return {id: product.id, name: product.name, price: product.price, quantity: entry.quantity, ...(product.size ? {size: product.size} : {})};
        });
        const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
        const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
        const discount = db.bulk.tiers.filter(tier => quantity >= tier.quantity).at(-1)?.discount || 0;
        const order = {id: randomUUID(), userId: user.id, name: user.name, email: user.email, items, quantity, subtotal, discount, total: Math.round(subtotal * (1 - discount / 100)), address: clean(input.address, 500), phone: clean(input.phone, 30), note: clean(input.note, 1000), status: 'Pending confirmation', created: new Date().toISOString()};
        db.orders.push(order);
        return order;
      });
      return reply({order}, 201);
    }
    if (path.startsWith('/api/orders/') && method === 'PATCH') {
      if (!['Pending confirmation', 'Confirmed', 'Dispatched', 'Cancelled'].includes(input.status)) fail(400, 'Invalid order status.');
      await update(db => { owner(db); const order = db.orders.find(item => item.id === path.split('/').pop()); if (!order) fail(404, 'Order not found.'); order.status = input.status; });
      return reply({ok: true});
    }
    return reply({error: 'Endpoint not found.'}, 404);
  } catch (error) {
    return reply({error: error.status ? error.message : 'Unable to complete this request.'}, error.status || 500);
  }
}
