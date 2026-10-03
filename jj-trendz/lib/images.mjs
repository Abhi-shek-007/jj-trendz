import sharp from 'sharp';
import {randomUUID} from 'node:crypto';
export async function sanitizeImage(bytes) {
  if(bytes.length > 2*1024*1024) throw Object.assign(new Error('Use photos under 2 MB.'),{status:400});
  try {
    const image=sharp(bytes,{limitInputPixels:25000000,failOn:'warning',animated:false});
    const metadata=await image.metadata();
    if(!['jpeg','png','webp'].includes(metadata.format) || metadata.pages > 1) throw new Error('Invalid image');
    // Re-encode to remove metadata and reject malformed/truncated files.
    return {path:`products/${randomUUID()}.webp`,bytes:await image.rotate().resize({width:2000,height:2000,fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer(),contentType:'image/webp'};
  } catch {throw Object.assign(new Error('This photo cannot be read. Choose a valid JPG, PNG or WebP.'),{status:400});}
}
