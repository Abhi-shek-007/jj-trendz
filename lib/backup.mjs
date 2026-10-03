import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
function key(value) {if(!/^[a-f0-9]{64}$/i.test(value||'')) throw new Error('BACKUP_KEY must be 64 hexadecimal characters.');return Buffer.from(value,'hex');}
export function encryptBackup(db,secret) {
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(secret),iv);
 const encrypted=Buffer.concat([cipher.update(JSON.stringify({format:1,created:new Date().toISOString(),db})),cipher.final()]);
 return JSON.stringify({format:1,iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:encrypted.toString('base64')});
}
export function decryptBackup(file,secret) {
 const payload=JSON.parse(file);if(payload.format!==1)throw new Error('Unknown backup format.');
 const decipher=createDecipheriv('aes-256-gcm',key(secret),Buffer.from(payload.iv,'hex'));decipher.setAuthTag(Buffer.from(payload.tag,'hex'));
 const result=JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data,'base64')),decipher.final()]).toString());
 if(result.format!==1 || !Array.isArray(result.db?.users) || !Array.isArray(result.db?.orders))throw new Error('Invalid backup.');
 return result.db;
}
