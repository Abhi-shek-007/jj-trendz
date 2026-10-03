import {readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
for(const dir of ['lib','api','scripts','public']) for(const file of await readdir(new URL('../'+dir,import.meta.url))) if(/\.(mjs|js)$/.test(file)) execFileSync(process.execPath,['--check',new URL('../'+dir+'/'+file,import.meta.url).pathname]);
console.log('Syntax checks passed.');
