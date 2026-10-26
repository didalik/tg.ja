#!/usr/bin/env node

// tg/ja/public/jr/compete.mjs -- self-service entry point for becoming a {{{1
// competing Agent (ccddh.md's "publish daeh, promote the Agent-offering
// flow" round): RTOJ a real unit of the real Owner's own Job asset,
// register into the shared catalog, then start actually selling it --
// the whole point of this file is that a real visitor, with nothing but a
// bare `git clone` + `npm install` of this repo, never has to hand-
// assemble the half-dozen env vars this session's own testing needed each
// time (see ../register.js/../run.js/../gate.js's own headers for what
// those are).
//
// No cert/CSR needed at all -- that's join/BIT2's own prerequisite for the
// mTLS-gated peer flow specifically, not a requirement of RTOJ+gate.js --
// so this is reachable immediately, no join detour required.
//
// Runs no owner-side code at all: Дід Alik's own, already-running
// toll_gate_join.service is what actually fills the RTOJ offer below,
// unconditionally, the same way it bootstraps a brand-new join applicant
// (daeh/lib/rtoj.mjs's own watchForResellers/allowReseller) -- this script
// is purely the buyer's own half.
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
//   TG_WS_URL   -- optional, defaults to the qa deploy

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Keypair } from '@stellar/stellar-sdk'
import { findPk } from '@amissine/daeh/find-pk.mjs'
import { generate_keypair } from '@amissine/daeh/sdk.js'
import { buyRtoj } from '@amissine/daeh/rtoj.mjs'

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
await buyRtoj({
  kp, ownerPk, assetCode,
  onLog: line => console.log('[compete] rtoj', line),
})
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
// No mTLS here, unlike register.js's own call above -- a fresh competing
// identity has no cert to present at all (that's join/BIT2's own
// prerequisite, not this flow's), and unlike register.js's own
// try/catch-wrapped mtlsAgent() use, run.js's own mtlsOptions() call is
// unguarded (caught live: a real ENOENT crash reading a cert file that
// was never going to exist). Presenting a cert is optional either way
// (see run.js's own header) -- this just leaves it off instead of
// crashing on a cert this identity was never going to have.
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
  },
})
process.exitCode = result.status ?? 1
