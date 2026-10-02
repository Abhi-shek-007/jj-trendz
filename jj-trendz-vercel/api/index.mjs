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
        upload: async (path, bytes, contentType) => {
          if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Connect a public Vercel Blob store to enable photo uploads.');
          const blob = await put(path, bytes, {access: 'public', contentType});
          return blob.url;
        }
      });
    } catch (error) {
      return Response.json({error: error.message || 'Unable to complete this request.'}, {status: 500, headers: {'Cache-Control': 'no-store'}});
    }
  }
};
