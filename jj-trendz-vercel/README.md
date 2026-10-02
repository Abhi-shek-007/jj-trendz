# JJ TrendZ — Vercel edition

This folder is a standalone GitHub repository for the JJ TrendZ jewellery site. Vercel serves the storefront from `public/` and runs the API in `api/index.mjs`. [Neon Postgres](https://vercel.com/marketplace/neon/neon) stores the catalogue, accounts, sessions, enquiries, discounts and orders. A **public** [Vercel Blob](https://vercel.com/docs/vercel-blob) store holds photographs uploaded by the owner.

## Put it on GitHub and Vercel

1. Create a GitHub repository. Upload **the contents of this folder** to the repository root: `public/`, `api/`, `lib/`, `tests/`, `.github/`, `package.json`, `package-lock.json`, `vercel.json`, `.gitignore`, `.env.example`, and this README. If you upload the folder itself into a larger repository, select `jj-trendz-vercel` as the **Root Directory** when importing into Vercel. Never upload `.env`, `node_modules/`, local `data/`, or local `uploads/`.
2. In Vercel, **Add New → Project**, import the GitHub repository and choose **Other** for Framework Preset. The `public/` directory is the static site; `vercel.json` routes `/owner` to the page and `/api/*` to the Function.
3. In the project's **Storage** tab, add a **Neon Postgres** database and connect it to this project. Confirm the project receives `DATABASE_URL`. Add a **Vercel Blob** store with **Public** access and connect it to this project. Confirm it receives `BLOB_READ_WRITE_TOKEN`. The API creates its own table on the first request.
4. In **Settings → Environment Variables**, set `OWNER_EMAIL` to your email and `OWNER_PASSWORD` to a unique password of 12–128 characters. Add them for Production; add them for Preview too if you want preview logins. Do not place real credentials in the repository. Redeploy after connecting storage and setting the variables.
5. Open the Vercel URL. The owner login is at `/owner`. Sign in, replace the sample products/photos, set your contact details and bulk discounts, then test a customer registration and order. The live database starts with demo products and no customer accounts or orders.

Because this is a commercial jewellery shop, use a Vercel **Pro or Enterprise** plan for the live site; [Vercel's Hobby terms limit it to non-commercial personal use](https://vercel.com/docs/limits/fair-use-guidelines). Neon and Blob have their own usage and billing terms.

## Local checks

Use Node.js 22 or later. Run `npm ci`, `npm run check`, and `npm test` from this folder. These tests exercise the API with temporary in-memory state, so no database or Blob account is needed. For a full local browser preview, link the Vercel project and pull its environment variables, then run `vercel dev` from this folder. Keep the pulled `.env` files private.

The site accepts product photos up to 2 MB. Checkout records an order for owner confirmation; online payments are not connected. Products, accounts and orders are stored in one versioned database row, which avoids lost updates for this small v0.5 shop but should be split into tables before substantial traffic. Uploaded Blob files are retained if a product is deleted, so review the Blob dashboard occasionally. Keep private database backups. Existing local `data/store.json` and `uploads/` are **not** transferred by GitHub; importing them requires a separate private migration.
