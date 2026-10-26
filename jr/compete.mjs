#!/usr/bin/env node

// tg/ja/public/jr/compete.mjs -- self-service entry point for becoming a {{{1
// competing Agent (ccddh.md's "publish daeh, promote the Agent-offering
// flow" round, cert requirement added the next round): RTOJ a real unit
// of the real Owner's own Job asset, register into the shared catalog,
// then start actually selling it -- the whole point of this file is that
// a real visitor, with nothing but a bare `git clone` + `npm install` of
// this repo, never has to hand-assemble the half-dozen env vars this
// session's own testing needed each time (see
// ../register.js/../run.js/../gate.js's own headers for what those are).
//
// Does need a real cert, it turns out (ccddh.md's "automate join's cert
// chores" round corrected an earlier, wrong claim here that it didn't):
// tg/ws's own Match handler unconditionally rejects any Agent connection
// lacking a verified mTLS client cert -- confirmed live, the hard way: a
// cert-less test identity's own offer was silently never actually served,
// every single time, invisible only because Дід Alik's own real,
// certified Agent was also concurrently idle under the same aud and
// every test job is the same trivial echo. If this identity has no cert
// yet, this joins first (join.mjs's own joinAndWait() -- CSR, RTOJ,
// queue, then wait for a human's own explicit approval via
// join-approve.mjs before a real cert comes back) -- that same RTOJ
// trade already grants real inventory of the asset being joined
// against, so a first-time visitor gets both the cert and its first
// unit of real inventory from this one step, no separate, redundant
// RTOJ needed. An identity that already has a cert (a returning visitor)
// skips straight to RTOJ-for-inventory, same as before.
//
// Runs no owner-side code at all beyond what join-approve.mjs itself
// requires (a human, explicitly, on this one specific box): Дід Alik's
// own, already-running toll_gate_join.service is what actually fills
// the RTOJ offer below, unconditionally, the same way it bootstraps any
// join applicant (daeh/lib/rtoj.mjs's own watchForResellers/
// allowReseller) -- this script is purely the buyer's own half.
//
// Resolves its own identity by name (WHOAMI), same "resolve-or-mint a
// stable keypair" shape ../Makefile's own peer target already uses --
// reused here via daeh/find-pk.mjs's own findPk() rather than its CLI
// wrapper, since this is already JS, not a Makefile recipe.
//
// Usage: node compete.mjs
// Env:
//   WHOAMI      -- optional, defaults to 'me' -- this identity's own name
//   OWNER_PK    -- required: the real Owner's own Stellar public key (the
//                  same one jr's own TG_ISSUER_PK would target to request
//                  this Job directly)
//   ASSET_CODE  -- optional, defaults to 'ECHO'
//   PRICE       -- optional, defaults to '0.5' -- XLM per unit sold
//   DESCRIPTION -- optional, shown on the intro page's own catalog card
//   JOIN_EMAIL  -- required only the first time (no cert yet): where the
//                  issued cert should be sent (see join.mjs's own header)
//   JOIN_POLL_TIMEOUT_MS -- optional, see join.mjs's own header -- unset
//                  waits forever for a human to approve or reject
//   TG_WS_URL   -- optional, defaults to the qa deploy

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Keypair } from '@stellar/stellar-sdk'
import { findPk } from '@amissine/daeh/find-pk.mjs'
import { generate_keypair } from '@amissine/daeh/sdk.js'
import { buyRtoj } from '@amissine/daeh/rtoj.mjs'
import { certDirFor, generateCsr, joinAndWait } from './join.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const whoami = process.env.WHOAMI ?? 'me'
const ownerPk = process.env.OWNER_PK
if (!ownerPk) throw new Error('OWNER_PK must be set (the real Owner you are reselling)');
const assetCode = process.env.ASSET_CODE ?? 'ECHO'
const price = process.env.PRICE ?? '0.5'
const wsUrl = process.env.TG_WS_URL ?? 'wss://qa.ws.tg.kloudoftrust.org/ja'

const testnetDir = path.join(process.env.HOME, '.config', '.testnet')
const cloudflareDir = path.join(process.env.HOME, '.config', '.cloudflare-job-fair')
fs.mkdirSync(testnetDir, { recursive: true })

//async function resolveIdentity () {{{1
/** Reuses an already-minted keypair for this name (same resilience
 * reasoning tg/Makefile's own ${TEST}-reset has: a real identity's own
 * key should survive this script being re-run), minting one on first
 * use -- see daeh/lib/sdk.js's own generate_keypair. */
async function resolveIdentity () {
  const existingPk = await findPk(whoami)
  if (existingPk) {
    const sk = fs.readFileSync(path.join(testnetDir, `${existingPk}.sk`), 'utf-8').trim()
    return { sk, pk: existingPk };
  }
  const [sk, pk] = (await generate_keypair()).split(' ')
  fs.writeFileSync(path.join(testnetDir, `${pk}.sk`), sk, { mode: 0o600 })
  fs.mkdirSync(path.join(cloudflareDir, pk), { recursive: true })
  fs.writeFileSync(path.join(cloudflareDir, pk, 'extras.json'), JSON.stringify({ name: whoami }, null, 2))
  return { sk, pk };
}

const { sk, pk } = await resolveIdentity()
console.log(`[compete] ${whoami} = ${pk}`)

const kp = Keypair.fromSecret(sk)
const certPath = path.join(certDirFor(pk), 'cert.pem')

if (fs.existsSync(certPath)) {
  // Returning identity -- already has a real cert, just needs more
  // inventory (same restock mechanism run.js's own loop already uses
  // when it sells out -- see its own header).
  console.log(`[compete] ${pk} already has a cert -- RTOJing for inventory only`)
  await buyRtoj({ kp, ownerPk, assetCode, onLog: line => console.log('[compete] rtoj', line) })
} else {
  // First time: no cert, so no way to actually serve a real Job yet
  // (tg/ws's own mTLS check -- see this file's own header). join first
  // -- its own RTOJ trade already grants the first real unit of
  // inventory, so nothing else is needed here before registering.
  const email = process.env.JOIN_EMAIL
  if (!email) throw new Error('JOIN_EMAIL must be set (no cert yet -- this identity needs to join first)');
  console.log(`[compete] ${pk} has no cert yet -- joining first`)
  const dir = certDirFor(pk)
  const cn = `compete-${whoami}`
  const { csr } = await generateCsr(pk, cn, dir)
  // storeCert() (called inside joinAndWait(), below) reads this back --
  // same bridge join.mjs's own main() uses, needed there to cross a real
  // process boundary (CSR generation and cert storage used to be two
  // separate `node join.mjs` invocations). Still the simplest way to
  // keep storeCert() itself identical for both callers, even though
  // compete.mjs's own two steps happen to run in the same process.
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'sidecar.json'), JSON.stringify({ network: 'testnet', sk }) + '\n')
  await joinAndWait({
    kp, ownerPk, assetCode, wsUrl, csr, email, name: whoami,
    pollTimeoutMs: process.env.JOIN_POLL_TIMEOUT_MS ? Number(process.env.JOIN_POLL_TIMEOUT_MS) : undefined,
    onLog: line => console.log('[compete] join', line),
  })
}
console.log(`[compete] now holding real ${assetCode} -- registering and starting the gate`)

execFileSync('node', ['register.js', 'ja'], {
  cwd: path.join(__dirname, '..'), // register.js lives at the repo root, not jr/
  stdio: 'inherit',
  env: {
    ...process.env,
    TG_ISSUER_PK: pk,
    TG_ASSET_CODE: assetCode,
    TG_PRICE: price,
    TG_ASSET_ISSUER_PK: ownerPk,
    TG_DESCRIPTION: process.env.DESCRIPTION ?? `Resold by ${whoami}`,
    TG_WS_URL: wsUrl,
    mTLS: 'true',
  },
})

// run.js is the long-running foreground process from here on -- spawnSync
// (not execFileSync) just to keep this file's own intent explicit: this
// genuinely runs until killed, same as any other Agent process.
//
// mTLS=true here now (ccddh.md's "automate join's cert chores" round --
// this used to deliberately omit it, on the wrong premise that reselling
// didn't need a cert at all; it does, see this file's own header). By
// this point this identity either already had a cert or just joined to
// get one, so there's always a real cert.pem/cert.key at certDirFor(pk)
// for run.js's own mtlsOptions() to present -- its own safeMtlsOptions()
// guard (a separate fix, same round) still covers the case of any
// *other* caller that reaches here without one.
const result = spawnSync('node', ['../run.js'], {
  cwd: path.join(__dirname, '..', 'jobs'),
  stdio: 'inherit',
  env: {
    ...process.env,
    TG_AGENT_SK: sk,
    TG_AGENT_PK: pk,
    TG_AGENT_NAME: whoami,
    TG_ISSUER_SK: sk,
    TG_ASSET_CODE: assetCode,
    TG_ASSET_ISSUER_PK: ownerPk,
    TG_PRICE: price,
    TG_WS_URL: wsUrl,
    mTLS: 'true',
  },
})
process.exitCode = result.status ?? 1
