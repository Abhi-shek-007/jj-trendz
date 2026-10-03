import {readFile} from 'node:fs/promises';
import {createPool,readState,writeState} from '../lib/store.mjs';
import {decryptBackup} from '../lib/backup.mjs';
const filename=process.argv[2];
if(!filename || process.env.RESTORE_TO_EMPTY_DATABASE!=='yes')throw new Error('Set RESTORE_TO_EMPTY_DATABASE=yes and supply an encrypted backup file. Restore only into a new isolated database.');
const snapshot=decryptBackup(await readFile(filename,'utf8'),process.env.BACKUP_KEY);
// Never revive authentication state from a backup.
snapshot.sessions={};snapshot.otpChallenges={};snapshot.loginAttempts={};snapshot.otpRate={};snapshot.requestRate={};snapshot.inquiryRate={};
const pool=createPool(process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL),client=await pool.connect();
try {
 await client.query('BEGIN');
 await client.query(await readFile(new URL('../migrations/001-commerce.sql',import.meta.url),'utf8'));
 await client.query("SELECT id FROM shop_settings WHERE id='transaction-lock' FOR UPDATE");
 const current=await readState(client);
 if(current.users.length || current.orders.length || current.products.length || current.inquiries.length || current.contact)throw new Error('Restore refused: target database is not empty.');
 await writeState(client,current,snapshot);
 await client.query('INSERT INTO shop_migrations(version) VALUES(1) ON CONFLICT DO NOTHING');
 await client.query('COMMIT');console.log('Database restored. Sessions revoked. Run migration to reconcile OWNER_EMAIL, then verify image access before switching traffic.');
} catch(error) {await client.query('ROLLBACK');console.error('Restore failed:',error.code || error.message);process.exitCode=1;}
finally {client.release();await pool.end();}
