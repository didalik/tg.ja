#!/usr/bin/env node

// tg/ja/public/register.js -- registers this Job Agent's identity into {{{1
// tg/ws's one shared job catalog (POST /catalog/registry, keyed server-side
// by `${assetCode}:${issuerPk}` -- see index.ts's registryFetch), so jr can
// discover an Agent's Stellar issuer PK (and the DEX-trade details needed
// to match it) instead of needing it plumbed through a Makefile PK= var.
//
// Promoted here from tg/register.js (ccddh.md's "publish daeh, promote the
// Agent-offering flow" round): a standalone clone of this repo alone never
// had this file at all, so there was no way to actually show up in the
// catalog -- only daeh's own import below needed to change (bare
// specifier, resolved via node_modules now that daeh is npm-published),
// nothing else. tg/register.js stays behind unchanged, still what Дід
// Alik's/JA2's own ${TEST}-reset target (tg/Makefile) runs.
//
// Presents this Agent's own mTLS client cert (keyed by its own issuer PK,
// see ./mtls.mjs) when mTLS=true is set -- hx's own precedent for
// authenticating a write like this. Not enforced by tg/ws itself yet (see
// index.ts's registryFetch), just by whatever's configured at the edge
// once qa/prod have a real mTLS policy on this route. Only actually
// presentable for a stable-key identity (round 20's MRT unification) --
// one with no cert of its own (ja's own rotating issuer key) has nothing
// to present here either way.
//
// Usage: node register.js <smName>
//
// Env:
//   TG_ISSUER_PK   -- required: this Agent's own Stellar public key
//   TG_ASSET_CODE  -- optional, defaults to 'TGA' -- must match gate.js's
//   TG_PRICE       -- optional, defaults to '1' -- must match gate.js's
//   TG_HOME_DOMAIN -- optional
//   TG_AUD         -- optional: which `aud` a Requester should ask for
//                     once connected, if this identity offers more than
//                     one and the default a caller would otherwise
//                     assume isn't right
//   TG_DESCRIPTION -- optional: a human-readable description of this
//                     Job, shown to a visitor picking between entries
//                     that share one assetCode on purpose (ccddh.md --
//                     same Job name, genuinely different offerings)
//   TG_ASSET_ISSUER_PK -- optional, defaults to TG_ISSUER_PK: set this to
//                     the real issuer's own PK when registering a
//                     reseller (gate.js's own mirror-image env var) --
//                     see types.ts's RegistryEntry.realIssuerPk
//   TG_WS_URL      -- optional, defaults to the qa deploy -- only its
//                     origin matters here (the catalog is global, not
//                     smName-scoped); https-ified to reach the registry
//                     endpoint on the same Worker
//   mTLS           -- optional, 'true' to present the shared client cert

import https from 'node:https'
import { mtlsAgent } from './mtls.mjs'
import { httpize } from 'daeh/util.mjs'

const smName = process.argv[2]
if (!smName) throw new Error('usage: node register.js <smName>');

const issuerPk = process.env.TG_ISSUER_PK
if (!issuerPk) throw new Error('TG_ISSUER_PK must be set (this Agents own Stellar public key)');

const wsUrl = process.env.TG_WS_URL ?? 'wss://qa.ws.tg.kloudoftrust.org/ja'
// new URL(path, base) only keeps base's own origin, discarding whatever
// smName-shaped path was in it -- no manual stripping needed to always
// land on the one shared catalog regardless of wsUrl's own shape.
const registryUrl = new URL('/catalog/registry', httpize(wsUrl))

const entry = {
  issuerPk,
  smName,
  assetCode: process.env.TG_ASSET_CODE ?? 'TGA',
  price: process.env.TG_PRICE ?? '1',
  homeDomain: process.env.TG_HOME_DOMAIN,
  realIssuerPk: process.env.TG_ASSET_ISSUER_PK ?? issuerPk,
  ...(process.env.TG_AUD ? { aud: process.env.TG_AUD } : {}),
  ...(process.env.TG_DESCRIPTION ? { description: process.env.TG_DESCRIPTION } : {}),
}
const body = JSON.stringify(entry)

// Not fatal if this identity has no cert of its own (ja's own rotating
// issuer key never gets one issued) -- this route doesn't enforce mTLS
// yet either way, so presenting none here is a no-op, not a regression.
let agent
try {
  agent = mtlsAgent(issuerPk)
} catch { /* no cert for this PK -- register without one */ }

await new Promise((resolve, reject) => {
  const req = https.request(registryUrl, {
    method: 'POST',
    agent,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  }, res => {
    res.resume()
    res.on('end', () => res.statusCode && res.statusCode < 300
      ? resolve()
      : reject(new Error(`register.js: POST ${registryUrl} -> ${res.statusCode}`)));
  })
  req.on('error', reject)
  req.end(body)
})

console.log('register.js: registered', smName, entry)
