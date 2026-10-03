import test from 'node:test';
import assert from 'node:assert/strict';
import {encryptBackup,decryptBackup} from '../lib/backup.mjs';
test('encrypted backups round trip and reject wrong keys or tampering',()=>{
 const db={users:[{id:'test',email:'private@example.test'}],orders:[]},key='a'.repeat(64);
 const encrypted=encryptBackup(db,key);assert(!encrypted.includes('private@example.test'));
 assert.deepEqual(decryptBackup(encrypted,key),db);
 assert.throws(()=>decryptBackup(encrypted,'b'.repeat(64)));
 const tampered=JSON.parse(encrypted);tampered.tag='0'.repeat(32);assert.throws(()=>decryptBackup(JSON.stringify(tampered),key));
 assert.throws(()=>encryptBackup(db,'short'));
});
