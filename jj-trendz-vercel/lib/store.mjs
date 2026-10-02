import {randomBytes, randomUUID, scryptSync} from 'node:crypto';
import {neon} from '@neondatabase/serverless';
import {initialProducts} from './catalog.mjs';

const email = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const passwordHash = password => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
};

export function createStore(env = process.env) {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Connect a Neon Postgres database in Vercel Storage.');
  }

  const ownerEmail = String(env.OWNER_EMAIL || '').trim().toLowerCase();
  if (!email(ownerEmail) ||
      typeof env.OWNER_PASSWORD !== 'string' ||
      env.OWNER_PASSWORD.length < 12 ||
      env.OWNER_PASSWORD.length > 128) {
    throw new Error('Set OWNER_EMAIL and OWNER_PASSWORD (12–128 characters) in Vercel environment variables.');
  }

  const resetVersion = String(env.OWNER_RESET_VERSION || '').trim();
  if (resetVersion.length > 128) {
    throw new Error('OWNER_RESET_VERSION must be 128 characters or fewer.');
  }

  const sql = neon(env.DATABASE_URL);
  let ready;

  const initialise = () => ready ||= (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS jj_trendz_state (
        id integer PRIMARY KEY,
        version bigint NOT NULL,
        data jsonb NOT NULL
      )
    `;

    const initial = {
      products: initialProducts,
      users: [{
        id: randomUUID(),
        name: 'JJ TrendZ Owner',
        email: ownerEmail,
        password: passwordHash(env.OWNER_PASSWORD),
        role: 'owner'
      }],
      sessions: {},
      inquiries: [],
      orders: [],
      loginAttempts: {},
      contact: {
        name: 'JJ TrendZ',
        email: '',
        phone: '',
        hours: 'Monday – Saturday, 10 AM – 7 PM'
      },
      bulk: {
        tiers: [
          {quantity: 10, discount: 5},
          {quantity: 25, discount: 10},
          {quantity: 50, discount: 15}
        ]
      },
      ...(resetVersion ? {ownerResetVersion: resetVersion} : {})
    };

    await sql`
      INSERT INTO jj_trendz_state (id, version, data)
      VALUES (1, 1, ${JSON.stringify(initial)}::jsonb)
      ON CONFLICT (id) DO NOTHING
    `;

    // A new reset version changes only the saved owner credentials.
    if (resetVersion) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const [row] = await sql`
          SELECT version, data FROM jj_trendz_state WHERE id = 1
        `;
        if (!row) throw new Error('JJ TrendZ database is not initialized.');

        const db = row.data;
        if (db.ownerResetVersion === resetVersion) return;

        const owner = db.users.find(user => user.role === 'owner');
        if (!owner) throw new Error('Owner account was not found.');
        if (db.users.some(user =>
          user.id !== owner.id && user.email === ownerEmail
        )) {
          throw new Error('OWNER_EMAIL is already used by a customer account.');
        }

        const previousEmail = owner.email;
        owner.email = ownerEmail;
        owner.password = passwordHash(env.OWNER_PASSWORD);

        // Sign out any sessions created with the old owner credentials.
        for (const [token, session] of Object.entries(db.sessions)) {
          if (session.userId === owner.id) delete db.sessions[token];
        }

        if (db.loginAttempts) {
          delete db.loginAttempts[previousEmail];
          delete db.loginAttempts[ownerEmail];
        }

        db.ownerResetVersion = resetVersion;

        const saved = await sql`
          UPDATE jj_trendz_state
          SET version = version + 1,
              data = ${JSON.stringify(db)}::jsonb
          WHERE id = 1 AND version = ${row.version}
          RETURNING version
        `;
        if (saved.length) return;
      }

      throw new Error('Owner reset could not complete. Please retry.');
    }
  })().catch(error => {
    ready = undefined;
    throw error;
  });

  async function read() {
    await initialise();
    const rows = await sql`
      SELECT version, data FROM jj_trendz_state WHERE id = 1
    `;
    if (!rows.length) throw new Error('JJ TrendZ database is not initialized.');
    return {version: Number(rows[0].version), db: rows[0].data};
  }

  async function update(change) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const {version, db} = await read();
      const result = change(db);
      const saved = await sql`
        UPDATE jj_trendz_state
        SET version = version + 1,
            data = ${JSON.stringify(db)}::jsonb
        WHERE id = 1 AND version = ${version}
        RETURNING version
      `;
      if (saved.length) return result;
    }
    throw Object.assign(
      new Error('The shop is busy. Please retry.'),
      {status: 503}
    );
  }

  return {read, update};
}
