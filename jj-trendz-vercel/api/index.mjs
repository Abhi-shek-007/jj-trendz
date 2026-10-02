import {put} from '@vercel/blob';
import {createStore} from '../lib/store.mjs';
import {handle} from '../lib/handler.mjs';

let store;

export default {
  async fetch(request) {
    try {
      store ||= createStore();
      return await handle(request, {
        ...store,
        ownerAccess: {email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD},
        upload: async (path, bytes, contentType) => {
          try {
            const blob = await put(path, bytes, {access: 'public', contentType});
            return blob.url;
          } catch (error) {
            console.error('JJ TrendZ photo upload failed:', error);
            throw Object.assign(new Error('Photo upload failed. Check that a public Vercel Blob store is connected to this project, then redeploy.'), {status: 503});
          }
        }
      });
    } catch (error) {
      return Response.json({error: error.message || 'Unable to complete this request.'}, {status: 500, headers: {'Cache-Control': 'no-store'}});
    }
  }
};
