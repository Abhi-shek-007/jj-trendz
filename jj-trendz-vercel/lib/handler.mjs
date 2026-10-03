import {createHash, createHmac, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual} from 'node:crypto';
import QRCode from 'qrcode';
import {defaultSizes, optionList, productColors, productSizes, stockKey, variantStock, withOptions} from './variants.mjs';
import {defaultCheckout, defaultHeroCopy, upiUri, validUpiId} from './payments.mjs';

const clean = (value, max = 1500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const razorpayLink = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'rzp.io' && /^\/i\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
};
const secureLink = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
};
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

export async function handle(request, {read, update, upload, mailer, otpSecret, secureCookies = false, production = false, ownerAccess, rateLimit}) {
  try {
    if (!otpSecret) throw new Error('OTP secret is not configured.');
    const tokenKey = token => production ? createHash('sha256').update(token || '').digest('hex') : token;
    const ownerTag = () => ownerAccess ? createHmac('sha256', otpSecret).update(ownerAccess.email + ':' + ownerAccess.password).digest('hex') : '';
    const sessionCookie = (token, age = 604800) => `jj_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secureCookies ? '; Secure' : ''}`;
    const otpHash = (id, code) => createHmac('sha256', otpSecret).update(`${id}:${code}`).digest('hex');
    const url = new URL(request.url);
    const route = url.searchParams.get('route') || url.pathname.replace(/^\/api\//, '');
    const path = '/api/' + route.replace(/^\/+/, '');
    const method = request.method.toUpperCase();
    if (request.headers.get('origin') && new URL(request.headers.get('origin')).origin !== url.origin) fail(403, 'Request origin is not allowed.');
    const rawCookie = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith('jj_session='))?.slice(11);
    const cookie = tokenKey(rawCookie);
    const currentUser = db => {
      const session = cookie && db.sessions[cookie];
      if (session?.expires <= Date.now()) return null;
      const user = session && db.users.find(item => item.id === session.userId);
      if (production && user?.role === 'owner' && session.ownerTag !== ownerTag()) return null;
      if (user?.role === 'customer' && !user.emailVerified) return null;
      return user || null;
    };
    const owner = db => { const user = currentUser(db); if (user?.role !== 'owner') fail(403, 'Owner access is required.'); return user; };
    const customer = db => { const user = currentUser(db); if (user?.role !== 'customer') fail(user ? 403 : 401, 'Sign in with a customer account to place your order.'); return user; };
    const issueOtp = async ({mail, kind, name, passwordHash, userId}) => {
      if (!mailer?.send) fail(503, 'Email delivery is not configured.');
      const id = randomUUID(), code = String(randomInt(0, 1000000)).padStart(6, '0'), now = Date.now();
      await update(db => {
        const ownerEmail = db.users.find(user => user.role === 'owner')?.email;
        if (kind === 'register' && (mail === ownerEmail || db.users.some(user => user.email === mail))) fail(409, 'This email is already registered. Sign in instead.');
        if (['login', 'owner'].includes(kind) && !db.users.some(user => user.id === userId && user.email === mail && user.role === (kind === 'owner' ? 'owner' : 'customer'))) fail(401, 'Email or password is incorrect.');
        const rate = db.otpRate ||= {};
        const key = `${kind}:${mail}`;
        const previous = rate[key];
        if (previous?.last > now - 60000) fail(429, 'Please wait one minute before requesting another code.');
        if (previous?.window > now - 3600000 && previous.count >= 5) fail(429, 'Too many codes requested. Try again later.');
        rate[key] = {last: now, window: previous?.window > now - 3600000 ? previous.window : now, count: previous?.window > now - 3600000 ? previous.count + 1 : 1};
        const challenges = db.otpChallenges ||= {};
        for (const [otherId, challenge] of Object.entries(challenges)) if (challenge.expires < now || challenge.email === mail) delete challenges[otherId];
        challenges[id] = {email: mail, kind, name, passwordHash, userId, codeHash: otpHash(id, code), expires: now + 600000, attempts: 0, ownerTag: kind === 'owner' ? ownerTag() : ''};
      });
      try {
        await mailer.send({to: mail, subject: 'Your JJ TrendZ verification code', text: `Your JJ TrendZ verification code is ${code}.\n\nIt expires in 10 minutes. If you did not request this, ignore this email.`});
      } catch (error) {
        await update(db => { delete db.otpChallenges?.[id]; delete db.otpRate?.[`${kind}:${mail}`]; });
        throw error;
      }
      return reply({challengeId: id, email: mail, expiresIn: 600, preview: !!mailer.preview});
    };
    if (production && !['GET', 'HEAD'].includes(method)) {
      if (request.headers.get('origin') !== url.origin) fail(403, 'Request origin is not allowed.');
      if (Number(request.headers.get('content-length')) > 3 * 1024 * 1024) fail(413, 'Upload one photo at a time.');
      await rateLimit?.(request, path);
    }
    let input = {};
    if (!['GET', 'HEAD'].includes(method)) {
      if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, 'Send JSON data.');
      const body = await request.text();
      if (Buffer.byteLength(body) > (production ? 3 : 15) * 1024 * 1024) fail(413, 'Upload is too large. Use up to five images under 2 MB each.');
      try { input = JSON.parse(body || '{}'); } catch { fail(400, 'Invalid JSON.'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Send a JSON object.');
    }

    if (path === '/api/version' && method === 'GET') return reply({build: production ? 'vercel-v0.9-2026-10-03' : 'localhost-v0.9-2026-10-03'});

    if (path === '/api/catalog' && method === 'GET') {
      const {db} = await read();
      return reply({hostedUploads: production, products: db.products.filter(product => product.status !== 'draft').map(withOptions), contact: db.contact, bulk: db.bulk, heroImage: db.heroImage || '/assets/hero.jpg', heroCopy: db.heroCopy || defaultHeroCopy, policies: db.policies || {}, checkout: {deliveryFee: db.checkout?.deliveryFee ?? 0, payeeName: db.checkout?.payeeName || defaultCheckout.payeeName}});
    }
    if (path === '/api/me' && method === 'GET') {
      const {db} = await read();
      return reply({user: safeUser(currentUser(db))});
    }
    if (path === '/api/reset-password' && method === 'POST') {
      const mail = clean(input.email,150).toLowerCase();
      if (!validEmail(mail) || typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) fail(400, 'Enter your email and a new password of 8–128 characters.');
      const {db} = await read();
      const user = db.users.find(item => item.email === mail && item.role === 'customer');
      if (!user) return reply({challengeId:randomUUID(),email:mail,expiresIn:600});
      return await issueOtp({mail,kind:'reset',userId:user.id,passwordHash:hash(input.password)});
    }
    if (path === '/api/register' && method === 'POST') {
      const name = clean(input.name, 60), mail = clean(input.email, 150).toLowerCase();
      if (!name || !validEmail(mail) || typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) fail(400, 'Enter your name, a valid email and a password of 8–128 characters.');
      return await issueOtp({mail, kind: 'register', name, passwordHash: hash(input.password)});
    }
    if (path === '/api/login' && method === 'POST') {
      const mail = clean(input.email, 150).toLowerCase();
      const result = await update(db => {
        const now = Date.now();
        const attempts = db.loginAttempts ||= {};
        for (const [key, value] of Object.entries(attempts)) if (value.until < now) delete attempts[key];
        const recent = attempts[mail];
        if (recent?.count >= 12 && recent.until > now) fail(429, 'Too many login attempts. Try again in 15 minutes.');
        const ownerLogin = input.role === 'owner';
        const user = db.users.find(item => item.email === mail && item.role === (ownerLogin ? 'owner' : 'customer'));
        const validPassword = typeof input.password === 'string' && input.password.length <= 128 && user && (production && ownerLogin ? timingSafeEqual(createHash('sha256').update(input.password).digest(), createHash('sha256').update(ownerAccess.password).digest()) : verify(input.password, user.password));
        if (!user || !validPassword) {
          attempts[mail] = {count: (recent?.count || 0) + 1, until: recent?.until > now ? recent.until : now + 900000};
          return {failed: true};
        }
        delete attempts[mail];
        if (!ownerLogin || production) return {userId: user.id, email: user.email, kind: ownerLogin ? 'owner' : 'login'};
        const token = randomBytes(32).toString('hex');
        db.sessions[tokenKey(token)] = {userId: user.id, expires: now + 7 * 86400000};
        return {user: safeUser(user), token};
      });
      if (result.failed) fail(401, 'Email or password is incorrect.');
      if (!result.token) return await issueOtp({mail: result.email, kind: result.kind || 'login', userId: result.userId});
      return reply({user: result.user}, 200, sessionCookie(result.token));
    }
    if (path === '/api/verify-email' && method === 'POST') {
      const id = clean(input.challengeId, 100), code = typeof input.code === 'string' ? input.code.trim() : '';
      if (!/^[0-9]{6}$/.test(code)) fail(400, 'Enter the six-digit code from your email.');
      const result = await update(db => {
        const challenge = db.otpChallenges?.[id];
        if (!challenge || challenge.expires < Date.now()) { if (challenge) delete db.otpChallenges[id]; return {expired: true}; }
        if (challenge.attempts >= 5) return {locked: true};
        const expected = Buffer.from(challenge.codeHash, 'hex');
        const actual = Buffer.from(otpHash(id, code), 'hex');
        if (!timingSafeEqual(expected, actual)) { challenge.attempts++; return {invalid: true}; }
        delete db.otpChallenges[id];
        let user;
        if (challenge.kind === 'register') {
          if (db.users.some(item => item.email === challenge.email)) return {conflict: true};
          user = {id: randomUUID(), name: challenge.name, email: challenge.email, password: challenge.passwordHash, role: 'customer', emailVerified: true};
          db.users.push(user);
        } else {
          user = db.users.find(item => item.id === challenge.userId && item.email === challenge.email && item.role === (challenge.kind === 'owner' ? 'owner' : 'customer'));
          if (!user || challenge.kind === 'owner' && challenge.ownerTag !== ownerTag()) return {expired: true};
          user.emailVerified = true;
          if (challenge.kind === 'reset') {user.password = challenge.passwordHash;for (const [token,session] of Object.entries(db.sessions)) if (session.userId === user.id) delete db.sessions[token];}
        }
        const token = randomBytes(32).toString('hex');
        db.sessions[tokenKey(token)] = {userId: user.id, expires: Date.now() + (user.role === 'owner' ? 8 * 3600000 : 7 * 86400000), ...(user.role === 'owner' ? {ownerTag: ownerTag()} : {})};
        return {user: safeUser(user), token};
      });
      if (result.expired) fail(400, 'This code has expired. Request a new one.');
      if (result.locked) fail(429, 'Too many incorrect codes. Request a new one.');
      if (result.invalid) fail(400, 'Incorrect code. Please try again.');
      if (result.conflict) fail(409, 'This email is already registered. Sign in instead.');
      return reply({user: result.user}, 200, sessionCookie(result.token));
    }
    if (path === '/api/logout' && method === 'POST') {
      await update(db => { delete db.sessions[cookie]; });
      return reply({ok: true}, 200, sessionCookie('', 0));
    }
    if (path === '/api/password' && method === 'POST') {
      await update(db => {
        const user = currentUser(db);
        if (!user) fail(401, 'Sign in to change your password.');
        if (production && user.role === 'owner') fail(403, 'Change owner credentials in Vercel settings and redeploy.');
        if (typeof input.current !== 'string' || input.current.length > 128 || !verify(input.current, user.password)) fail(400, 'Current password is incorrect.');
        if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) fail(400, 'Use a password of 8–128 characters.');
        user.password = hash(input.password);
        for (const [token, session] of Object.entries(db.sessions)) if (session.userId === user.id && token !== cookie) delete db.sessions[token];
      });
      return reply({ok: true});
    }
    if (path === '/api/owner' && method === 'GET') {
      const {db} = await read(); owner(db);
      return reply({inquiries: db.inquiries, orders: db.orders, products: db.products.map(withOptions), checkout: db.checkout || defaultCheckout, heroCopy: db.heroCopy || defaultHeroCopy});
    }
    if (path === '/api/uploads' && method === 'POST') {
      const {db} = await read(); owner(db);
      const file = imageFromDataUrl(input.image);
      if (!file) fail(400, 'Choose a photo.');
      const image = await upload(`products/${randomUUID()}.${file.extension}`, file.bytes, `image/${file.kind}`);
      await update(latest => { owner(latest); (latest.uploads ||= {})[image] = {created: Date.now()}; });
      return reply({image});
    }
    if (path === '/api/products' && method === 'POST') {
      const name = clean(input.name, 100), caption = clean(input.caption);
      const price = Number(input.price), oldPrice = Number(input.oldPrice || 0);
      if (!name || !caption || !Number.isInteger(price) || price < 1 || price > 999999 || !Number.isInteger(oldPrice) || oldPrice < 0 || oldPrice > 999999 || (oldPrice && oldPrice <= price)) fail(400, 'Enter a valid selling price and an optional regular price higher than it.');
      if (!['Necklaces', 'Earrings', 'Bridal Sets', 'Bangles'].includes(input.category) || !['Everyday', 'Occasion', 'Festive'].includes(input.collection)) fail(400, 'Choose a valid category and collection.');
      const saleStart = clean(input.saleStart, 10), saleEnd = clean(input.saleEnd, 10);
      const validDate = date => !date || /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
      if (![saleStart, saleEnd].every(validDate) || saleStart && saleEnd && saleEnd < saleStart) fail(400, 'Choose valid sale dates in the correct order.');
      if ((saleStart || saleEnd) && !oldPrice) fail(400, 'Enter a regular price before scheduling a sale.');
      const featuredRank = input.featuredRank === undefined || input.featuredRank === '' ? 999 : Number(input.featuredRank);
      if (!Number.isInteger(featuredRank) || featuredRank < 1 || featuredRank > 9999) fail(400, 'Featured order must be from 1 to 9999.');
      const status = input.status || 'live';
      if (!['live', 'draft'].includes(status)) fail(400, 'Choose Live or Draft.');
      const {db} = await read(); owner(db);
      const previous = db.products.find(product => product.id === input.id);
      const colors = optionList(input.colors, productColors(previous || {category: input.category}), 'colours');
      const sizes = optionList(input.sizes, previous?.category === input.category ? productSizes(previous) : defaultSizes(input.category), 'sizes');
      const oldImages = previous ? withOptions(previous).images : [];
      const imagesInput = Array.isArray(input.images) ? input.images : input.image ? [input.image] : oldImages;
      if (!imagesInput.length || imagesInput.length > 5) fail(400, 'Add 1–5 product photos.');
      const pendingImages = [];
      for (const source of imagesInput) {
        if (typeof source !== 'string') fail(400, 'Invalid product photo.');
        if (oldImages.includes(source) || production && db.uploads?.[source]?.created > Date.now()-86400000) { pendingImages.push({url: source}); continue; }
        if (production) fail(400, 'Upload each new photo before saving the product.');
        const file = imageFromDataUrl(source);
        if (!file) fail(400, 'Invalid product photo.');
        pendingImages.push({file});
      }
      const suppliedStock = input.stock === undefined ? previous?.stock || {} : input.stock;
      if (!suppliedStock || typeof suppliedStock !== 'object' || Array.isArray(suppliedStock)) fail(400, 'Invalid variant stock.');
      const stock = {};
      for (const color of colors) for (const size of sizes) {
        const key = stockKey(color, size), value = suppliedStock[key];
        if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 0 || value > 9999)) fail(400, 'Stock must be a whole number from 0 to 9999, or blank for untracked.');
        stock[key] = value === undefined ? null : value;
      }
      const relations = value => {
        if (value === undefined) return [];
        if (!Array.isArray(value) || value.length > 4 || new Set(value).size !== value.length || value.some(id => typeof id !== 'string' || id === input.id || !db.products.some(product => product.id === id))) fail(400, 'Choose up to four different matching products.');
        return value;
      };
      const relatedIds = relations(input.relatedIds), pairWithIds = relations(input.pairWithIds);
      const images = [];
      for (const item of pendingImages) {
        images.push(item.url || await upload(`products/${randomUUID()}.${item.file.extension}`, item.file.bytes, `image/${item.file.kind}`));
      }
      const product = await update(latest => {
        owner(latest);
        const old = latest.products.find(item => item.id === input.id);
        if (input.id && !old) fail(404, 'Product not found.');
        if (old && (production || input.revision !== undefined) && Number(input.revision) !== (old.revision || 0)) fail(409, 'This product or its stock changed. Reopen the editor before saving.');
        if (production && images.some(image => !(old?.images || [old?.image]).includes(image) && !(latest.uploads?.[image]?.created > Date.now()-86400000))) fail(409, 'A photo expired. Upload it again.');
        const item = {
          id: old?.id || randomUUID(), revision: (old?.revision || 0) + 1, name, caption, price, oldPrice, saleStart, saleEnd,
          category: input.category, collection: input.collection, badge: clean(input.badge, 40),
          image: images[0], images, colors, sizes, stock, status, featuredRank,
          createdAt: old?.createdAt || new Date().toISOString(),
          material: clean(input.material, 80), plating: clean(input.plating, 80),
          dimensions: clean(input.dimensions, 160), included: clean(input.included, 200),
          care: clean(input.care, 300), dispatchNote: clean(input.dispatchNote, 200),
          occasion: clean(input.occasion, 80), relatedIds, pairWithIds
        };
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
    if (path === '/api/checkout-settings' && method === 'POST') {
      const upiId = clean(input.upiId, 320), payeeName = clean(input.payeeName, 80), deliveryFee = Number(input.deliveryFee);
      if (!validUpiId(upiId) || !payeeName || input.deliveryFee === '' || input.deliveryFee === null || input.deliveryFee === undefined || !Number.isInteger(deliveryFee) || deliveryFee < 0 || deliveryFee > 99999) fail(400, 'Enter a valid UPI ID, payee name and delivery charge from ₹0 to ₹99,999.');
      await update(db => { owner(db); db.checkout = {upiId, payeeName, deliveryFee}; });
      return reply({ok: true});
    }
    if (path === '/api/policies' && method === 'POST') {
      const policies = Object.fromEntries(['privacy','shipping','returns','terms'].map(key => [key,clean(input[key],5000)]));
      if (Object.values(policies).some(value => !value)) fail(400, 'Complete each shop policy.');
      await update(db => {owner(db);db.policies=policies;});
      return reply({ok:true});
    }
    if (path === '/api/hero-copy' && method === 'POST') {
      const heroCopy = {eyebrow: clean(input.eyebrow, 80), headline: clean(input.headline, 100), highlight: clean(input.highlight, 100), description: clean(input.description, 400)};
      if (Object.values(heroCopy).some(value => !value)) fail(400, 'Complete every homepage text field.');
      await update(db => { owner(db); db.heroCopy = heroCopy; });
      return reply({heroCopy});
    }
    if (path === '/api/hero' && method === 'POST') {
      const {db} = await read(); owner(db);
      const file = imageFromDataUrl(input.image);
      if (!file && !(production && db.uploads?.[input.image]?.created > Date.now()-86400000)) fail(400, 'Choose a hero photograph.');
      const image = file ? await upload(`hero-${randomUUID()}.${file.extension}`, file.bytes, `image/${file.kind}`) : input.image;
      await update(latest => { owner(latest); if (production && !file && !(latest.uploads?.[image]?.created > Date.now()-86400000)) fail(409, 'Upload this photo again.'); latest.heroImage = image; });
      return reply({heroImage: image});
    }
    if (path === '/api/bulk' && method === 'POST') {
      if (!Array.isArray(input.tiers) || input.tiers.length > 5) fail(400, 'Use up to five discount tiers.');
      const tiers = input.tiers.map(tier => ({quantity: Number(tier.quantity), discount: Number(tier.discount)})).sort((a, b) => a.quantity - b.quantity);
      if (tiers.some((tier, i) => !Number.isInteger(tier.quantity) || tier.quantity < 2 || tier.quantity > 9999 || !Number.isFinite(tier.discount) || tier.discount < 0 || tier.discount > 80 || (i && tier.quantity === tiers[i - 1].quantity))) fail(400, 'Use unique minimum quantities from 2–9999 and discounts from 0–80%.');
      await update(db => { owner(db); db.bulk = {tiers}; });
      return reply({tiers});
    }
    if (/^\/api\/inquiries\/[^/]+$/.test(path) && method === 'PATCH') {
      const {db} = await read();owner(db);
      const inquiry = db.inquiries.find(item => item.id === path.split('/').pop());
      if (!inquiry) fail(404, 'Enquiry not found.');
      await mailer.send({to:db.contact.email || db.users.find(user => user.role === 'owner').email,replyTo:inquiry.email,subject:'JJ TrendZ enquiry',text:`Name: ${inquiry.name}\nEmail: ${inquiry.email}\nProducts: ${inquiry.productNames}\n\n${inquiry.message}`});
      await update(latest => {owner(latest);const saved=latest.inquiries.find(item => item.id===inquiry.id);if(saved)saved.emailSent=true;});
      return reply({ok:true});
    }
    if (path === '/api/inquiries' && method === 'POST') {
      if (!clean(input.name, 60) || !validEmail(input.email) || !clean(input.message, 2000)) fail(400, 'Enter your name, email and question.');
      const {db} = await read();
      const ownerEmail = db.contact.email || db.users.find(user => user.role === 'owner')?.email;
      if (!validEmail(ownerEmail)) fail(503, 'Owner email is not configured.');
      const sender = clean(input.email, 150).toLowerCase(), now = Date.now();
      const productNames = (Array.isArray(input.ids) ? input.ids.slice(0, 100) : []).map(id => db.products.find(product => product.id === id)?.name).filter(Boolean).join(', ');
      const inquiryId = randomUUID();
      await update(latest => {
        const rate = latest.inquiryRate ||= {}, recent = rate[sender];
        if (recent?.last > now - 30000 || recent?.window > now - 3600000 && recent.count >= 10) fail(429, 'Please wait before sending another enquiry.');
        rate[sender] = {last: now, window: recent?.window > now - 3600000 ? recent.window : now, count: recent?.window > now - 3600000 ? recent.count + 1 : 1};
        latest.inquiries.push({id: inquiryId, name: clean(input.name, 60), email: sender, message: clean(input.message, 2000), productNames, created: new Date().toISOString(), emailSent: false});
      });
      try {
        await mailer.send({to: ownerEmail, replyTo: sender, subject: `JJ TrendZ enquiry${productNames ? ' about ' + productNames.slice(0, 100) : ''}`, text: `Name: ${clean(input.name, 60)}\nEmail: ${sender}\nProducts: ${productNames || 'General enquiry'}\n\n${clean(input.message, 2000)}`});
        await update(latest => { const saved = latest.inquiries.find(item => item.id === inquiryId); if (saved) saved.emailSent = true; });
      } catch {
        return reply({ok: true, emailSent: false, warning: 'Your enquiry is saved. Email delivery is delayed; the owner can see it in their dashboard.'});
      }
      return reply({ok: true, preview: !!mailer.preview});
    }
    if (/^\/api\/orders\/[^/]+\/qr$/.test(path) && method === 'GET') {
      const {db} = await read(), user = customer(db);
      const id = path.split('/')[3];
      const order = db.orders.find(item => item.id === id && item.userId === user.id);
      if (!order || order.paymentMethod !== 'UPI' || order.paymentStatus !== 'Awaiting payment' || !order.upiUri) fail(404, 'Payment QR is unavailable.');
      const svg = await QRCode.toString(order.upiUri, {type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 280});
      return new Response(svg, {headers: {'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"}});
    }
    if (path === '/api/orders' && method === 'GET') {
      const {db} = await read(); const user = customer(db);
      return reply({orders: db.orders.filter(order => order.userId === user.id).map(order => ({...order, upiUri: order.paymentStatus === 'Awaiting payment' ? order.upiUri : ''}))});
    }
    if (path === '/api/orders' && method === 'POST') {
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) fail(400, 'Add products to your order.');
      if (production && (!/^[1-9][0-9]{5}$/.test(input.pincode || '') || !/^(?:\+91[ -]?)?[6-9][0-9]{9}$/.test(String(input.phone || '').replace(/[ ()-]/g,'')))) fail(400, 'Enter a valid Indian mobile number and six-digit PIN code.');
      if (!clean(input.address, 500) || !clean(input.phone, 30)) fail(400, 'Provide your contact number and delivery address.');
      const paymentMethod = input.paymentMethod || 'UPI';
      if (!['UPI', 'Razorpay'].includes(paymentMethod)) fail(400, 'Choose a valid payment method.');
      const idempotencyKey = clean(input.idempotencyKey, 100);
      if (production && !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) fail(400, 'Refresh checkout and try again.');
      const requestHash = createHash('sha256').update(JSON.stringify({items: input.items, address: input.address, phone: input.phone, pincode: input.pincode || '', note: input.note || '', paymentMethod})).digest('hex');
      const order = await update(db => {
        const user = customer(db), seen = new Set();
        const existing = idempotencyKey && db.orders.find(item => item.userId === user.id && item.idempotencyKey === idempotencyKey);
        if (existing) { if (existing.requestHash !== requestHash) fail(409, 'This checkout was already submitted with different details. Start a new checkout.'); return existing; }
        const items = input.items.map(entry => {
          const product = db.products.find(item => item.id === entry.id);
          if (!product || product.status === 'draft' || !Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 9999) fail(400, 'Check your products and quantities.');
          const colors = productColors(product), sizes = productSizes(product);
          const color = clean(entry.color, 30) || (colors.length === 1 ? colors[0] : '');
          const size = clean(entry.size, 30) || (sizes.length === 1 ? sizes[0] : '');
          if (!colors.includes(color) || !sizes.includes(size)) fail(400, 'Choose an available colour and size for each piece.');
          const key = `${product.id}\0${color}\0${size}`;
          if (seen.has(key)) fail(400, 'Combine duplicate colour and size choices in your bag.');
          seen.add(key);
          const remaining = variantStock(product, color, size);
          if (remaining === null) fail(409, `${product.name} is not available to order in ${color} / ${size} until the owner sets stock.`);
          if (remaining < entry.quantity) fail(409, `${product.name} has only ${remaining} available in ${color} / ${size}.`);
          product.stock[stockKey(color, size)] -= entry.quantity;
          product.revision = (product.revision || 0) + 1;
          return {id: product.id, name: product.name, price: withOptions(product).displayPrice, quantity: entry.quantity, color, size, stockReserved: true};
        });
        const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
        const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
        const discount = db.bulk.tiers.filter(tier => quantity >= tier.quantity).at(-1)?.discount || 0;
        const now = new Date().toISOString(), total = Math.round(subtotal * (1 - discount / 100));
        const checkout = {...defaultCheckout, ...db.checkout};
        const upi = paymentMethod === 'UPI';
        const id = randomUUID(), deliveryFee = upi ? checkout.deliveryFee : null;
        const payableTotal = upi ? total + deliveryFee : null;
        if (upi && (!Number.isInteger(payableTotal) || payableTotal < 1)) fail(400, 'The UPI amount must be at least ₹1. Review the price or discount.');
        const reference = upi ? `${Date.now()}${randomInt(100, 1000)}` : '';
        const order = {id, idempotencyKey: idempotencyKey || null, requestHash, reservationExpiresAt: new Date(Date.now() + 24 * 3600000).toISOString(), userId: user.id, name: user.name, email: user.email, items, quantity, subtotal, discount, total, paymentMethod, deliveryFee, payableTotal, paymentStatus: upi ? 'Awaiting payment' : 'Awaiting quote', paymentLink: '', paymentEmailSentAt: '', upiPayeeId: upi ? checkout.upiId : '', upiPayeeName: upi ? checkout.payeeName : '', upiReference: reference, upiUri: upi ? upiUri({upiId: checkout.upiId, payeeName: checkout.payeeName, amount: payableTotal, reference, orderId: id}) : '', paidAt: '', paymentReference: '', carrier: '', trackingNumber: '', trackingUrl: '', trackingEmailSentAt: '', dispatchedAt: '', pincode: clean(input.pincode, 6), address: clean(input.address, 500), phone: clean(input.phone, 30), note: clean(input.note, 1000), status: upi ? 'Confirmed' : 'Pending confirmation', confirmedAt: upi ? now : '', created: now};
        db.orders.push(order);
        return order;
      });
      return reply({order: {...order, upiUri: order.paymentStatus === 'Awaiting payment' ? order.upiUri : ''}}, 201);
    }
    if (path.startsWith('/api/orders/') && method === 'PATCH') {
      const action = input.action || (input.status === 'Cancelled' ? 'cancel' : '');
      if (!['confirm', 'payment-link', 'email-link', 'paid', 'dispatch', 'email-tracking', 'cancel'].includes(action)) fail(400, 'Choose a valid order action.');
      const order = await update(db => {
        owner(db);
        const order = db.orders.find(item => item.id === path.split('/').pop());
        if (!order) fail(404, 'Order not found.');
        if (action === 'cancel' && order.status === 'Cancelled') return order;
        if (action === 'cancel' && order.paymentStatus === 'Awaiting payment' && production && input.reconciled !== true) fail(400, 'Check payment receipts and disable any payment link before releasing this stock.');
        if (action === 'confirm') {
          if (order.paymentMethod === 'UPI' || !['Pending confirmation', 'Confirmed'].includes(order.status) || order.paymentLink) fail(400, 'The delivery quote can only be set before sending a payment link.');
          const fee = Number(input.deliveryFee);
          if (input.deliveryFee === '' || input.deliveryFee === null || input.deliveryFee === undefined || !Number.isInteger(fee) || fee < 0 || fee > 99999) fail(400, 'Enter a delivery charge from ₹0 to ₹99,999.');
          order.deliveryFee = fee;
          order.payableTotal = order.total + fee;
          order.paymentStatus = 'Awaiting link';
          order.status = 'Confirmed';
          order.confirmedAt ||= new Date().toISOString();
        } else if (action === 'payment-link') {
          if (order.paymentMethod === 'UPI' || order.status !== 'Confirmed' || order.paymentStatus === 'Paid' || order.paymentLink || !Number.isInteger(order.payableTotal)) fail(400, 'Confirm the delivery charge and use one payment link per order.');
          const link = clean(input.paymentLink, 500);
          if (!razorpayLink(link)) fail(400, 'Paste a Razorpay Payment Link beginning with https://rzp.io/i/.');
          order.paymentLink = link;
          order.paymentStatus = 'Awaiting payment';
          order.paymentEmailSentAt = '';
        } else if (action === 'email-link') {
          if (order.status !== 'Confirmed' || order.paymentStatus !== 'Awaiting payment' || !razorpayLink(order.paymentLink)) fail(400, 'There is no active payment link to email.');
        } else if (action === 'paid') {
          if (order.status !== 'Confirmed' || order.paymentStatus !== 'Awaiting payment' || (order.paymentMethod === 'UPI' ? !order.upiUri : !order.paymentLink)) fail(400, 'Payment must be requested before marking the order paid.');
          order.paymentStatus = 'Paid';
          order.paidAt = new Date().toISOString();
          order.paymentReference = clean(input.paymentReference, 100);
        } else if (action === 'dispatch') {
          if (order.status !== 'Confirmed' || order.paymentStatus !== 'Paid') fail(400, 'Confirm payment before dispatching the order.');
          const carrier = clean(input.carrier, 80), trackingNumber = clean(input.trackingNumber, 100), trackingUrl = clean(input.trackingUrl, 500);
          if (!carrier || !trackingNumber || !/^[\p{L}\p{N}][\p{L}\p{N} ._\/-]*$/u.test(trackingNumber) || trackingUrl && !secureLink(trackingUrl)) fail(400, 'Enter a carrier, valid tracking number, and optional HTTPS tracking link.');
          order.carrier = carrier;
          order.trackingNumber = trackingNumber;
          order.trackingUrl = trackingUrl;
          order.status = 'Dispatched';
          order.dispatchedAt = new Date().toISOString();
          order.trackingEmailSentAt = '';
        } else if (action === 'email-tracking') {
          if (order.status !== 'Dispatched' || !order.trackingNumber) fail(400, 'There is no shipment tracking to email.');
        } else if (action === 'cancel') {
          if (!['Pending confirmation', 'Confirmed'].includes(order.status) || order.paymentStatus === 'Paid') fail(400, 'Paid or dispatched orders need separate refund or delivery handling.');
          for (const item of order.items) {
            if (!item.stockReserved) continue;
            const product = db.products.find(value => value.id === item.id);
            const key = stockKey(item.color, item.size);
            if (product && Number.isInteger(product.stock?.[key])) { product.stock[key] += item.quantity; product.revision = (product.revision || 0) + 1; }
            item.stockReserved = false;
          }
          order.status = 'Cancelled';
          order.paymentStatus = 'Cancelled';
          order.paymentLink = '';
        }
        return order;
      });
      if (['payment-link', 'email-link', 'dispatch', 'email-tracking'].includes(action)) {
        try {
          if (!mailer?.send) throw new Error('Email delivery is not configured.');
          const payment = action === 'payment-link' || action === 'email-link';
          await mailer.send({to: order.email,
            subject: payment ? `JJ TrendZ payment link for order #${order.id.slice(0, 8).toUpperCase()}` : `JJ TrendZ order #${order.id.slice(0, 8).toUpperCase()} is on its way`,
            text: payment
              ? `Your JJ TrendZ order #${order.id.slice(0, 8).toUpperCase()} is confirmed.\n\nProducts: ₹${order.total}\nDelivery: ₹${order.deliveryFee}\nAmount to pay: ₹${order.payableTotal}\n\nPay securely with Razorpay: ${order.paymentLink}\n\nPlease check that the amount on the Razorpay page matches this order. JJ TrendZ will confirm payment before dispatch.`
              : `Your JJ TrendZ order #${order.id.slice(0, 8).toUpperCase()} has been dispatched.\n\nCarrier: ${order.carrier}\nTracking number: ${order.trackingNumber}${order.trackingUrl ? `\nTrack your parcel: ${order.trackingUrl}` : ''}\n\nYou can also see these details in My orders.`});
          await update(db => { const saved = db.orders.find(item => item.id === order.id); if (payment && saved?.paymentLink === order.paymentLink) saved.paymentEmailSentAt = new Date().toISOString(); else if (!payment && saved?.trackingNumber === order.trackingNumber) saved.trackingEmailSentAt = new Date().toISOString(); });
        } catch (error) {
          console.error('JJ TrendZ order email failed:', error.message);
          return reply({ok: true, emailSent: false, warning: 'Order saved, but the email could not be sent. The customer can still see the details in My orders; retry the email from the owner studio.'});
        }
        return reply({ok: true, emailSent: true});
      }
      return reply({ok: true});
    }
    return reply({error: 'Endpoint not found.'}, 404);
  } catch (error) {
    if (error.status) return reply({error: error.message}, error.status);
    const reference = randomUUID().slice(0, 8);
    console.error('JJ TrendZ API error', {
      reference,
      method: request.method,
      path: new URL(request.url).pathname,
      name: error.name,
      code: error.code
    });
    return reply({error: `Unable to complete this request. Error reference: ${reference}`, reference}, 500);
  }
}
