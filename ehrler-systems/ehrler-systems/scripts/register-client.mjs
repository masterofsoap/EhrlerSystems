#!/usr/bin/env node
// Registers an app that can use "Sign in with Ehrler Systems".
//
// Usage:
//   node scripts/register-client.mjs <client_id> "<App Name>" <redirect_uri> [more redirect_uris...]
//   node scripts/register-client.mjs govariety "GoVariety" https://govariety.pages.dev/auth/ehrler/callback
//
// Add --public for a browser-only app with no server (PKCE only, no secret).
//
// It prints the client secret ONCE (store it as a secret in the other app) and
// writes register-<client_id>.sql, which you apply with:
//   npx wrangler d1 execute ehrler-systems --remote --file=register-<client_id>.sql

import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const isPublic = args.includes("--public");
const [clientId, name, ...redirectUris] = args.filter((a) => a !== "--public");

if (!clientId || !name || redirectUris.length === 0) {
  console.error('Usage: node scripts/register-client.mjs <client_id> "<App Name>" <redirect_uri> [...] [--public]');
  process.exit(1);
}
if (!/^[a-z0-9-]{3,40}$/.test(clientId)) {
  console.error("client_id must be 3-40 chars: lowercase letters, numbers, dashes");
  process.exit(1);
}
for (const u of redirectUris) {
  const url = new URL(u);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    console.error(`Redirect URI must be https (or localhost): ${u}`);
    process.exit(1);
  }
}

const q = (s) => (s === null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
let secret = null;
let secretHash = null;
if (!isPublic) {
  secret = "ess_" + randomBytes(32).toString("base64url");
  secretHash = createHash("sha256").update(secret).digest("hex");
}
const homepage = new URL(redirectUris[0]).origin;
const sql = `INSERT INTO oauth_clients (id, name, secret_hash, redirect_uris, homepage_url, created_at)
VALUES (${q(clientId)}, ${q(name)}, ${q(secretHash)}, ${q(JSON.stringify(redirectUris))}, ${q(homepage)}, ${Date.now()})
ON CONFLICT(id) DO UPDATE SET name = excluded.name, secret_hash = excluded.secret_hash,
  redirect_uris = excluded.redirect_uris, homepage_url = excluded.homepage_url;
`;
const file = `register-${clientId}.sql`;
writeFileSync(file, sql);

console.log(`\nWrote ${file}. Apply it with:\n  npx wrangler d1 execute ehrler-systems --remote --file=${file}\n`);
console.log(`client_id:     ${clientId}`);
if (secret) {
  console.log(`client_secret: ${secret}`);
  console.log("\nSave the secret now — only its hash is stored. In the other app run:");
  console.log("  npx wrangler pages secret put EHRLER_CLIENT_SECRET");
} else {
  console.log("Public client: no secret. The app must use PKCE (S256).");
}
