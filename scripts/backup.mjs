import {writeFile} from 'node:fs/promises';
import {createStore} from '../lib/store.mjs';
import {encryptBackup} from '../lib/backup.mjs';
const filename=process.argv[2];
if(!filename)throw new Error('Usage: npm run backup -- /private/path/shop.backup');
const store=createStore();
try {const {db}=await store.read();await writeFile(filename,encryptBackup(db,process.env.BACKUP_KEY),{mode:0o600,flag:'wx'});console.log('Encrypted database backup saved. Back up image objects separately.');}
finally {await store.close();}
