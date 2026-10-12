#!/usr/bin/env node

// tg/ja/public/jr/join.mjs -- the join Use Case's Requester side (see {{{1
// ccddh.md's "The join Use Case and its BITs" and round 34's CSR fix):
// generates the Requester's own Stellar keypair and TLS CSR locally (the
// private key never leaves this process), buys access to a JA's 'join'
// gate -- 'join' is just another aud under the same toll-gate mechanism
// 'echo' already uses, so this reuses gate.js's buyGrant() directly
// rather than a separate module -- then sends {kind, csr, network, email}
// and prints the Agent's reply.
//
// Exports requestJoin() so tg/ja/join-agent.mjs can reuse the exact same
// flow to forward a non-root JA's incoming request on to Дід Alik's own
// 'join' gate ("join calling join", round 34), rather than duplicating
// it. requestJoin() never generates a CSR itself -- that's this file's
// own main() only -- so the forwarding path can pass the Requester's
// original CSR through unchanged.
//
// Env (direct CLI use):
//   TG_ISSUER_PK   -- required: the target JA's own Stellar public key
//   TG_ASSET_CODE  -- optional, defaults to 'JOIN' (this Job's own fixed
//                     selector -- see requestJoin()'s own comment)
//   TG_PRICE, TG_JR_SK, TG_GRANT_TIMEOUT_MS -- see gate.js.
//                     Setting TG_JR_SK up front (rather than letting
//                     buyGrant() generate one) is what makes this script's
//                     own CSR/OU and the gate-trade identity the same
//                     stable keypair (round 20's MRT design, same as sh's
//                     E/P/F) instead of jr's own 'echo' BIT's two separate,
//                     disposable ones.
//   TG_WS_URL      -- optional, defaults to the qa deploy
//   TG_MATCH_TIMEOUT_MS -- optional, defaults to 30000
//   JOIN_NETWORK   -- optional, defaults to 'testnet' -- Дід Alik's own
//                     bookkeeping only (round 34), not validated by any JA
//   JOIN_EMAIL     -- required: where the issued cert should be sent
//   JOIN_CN        -- optional, defaults to 'join-<shortid>' -- the CSR's
//                     own CN field
//   JOIN_CERT_DIR  -- optional, defaults to a fresh temp dir -- where the
//                     generated keypair/CSR are written. This directory
//                     (not the CSR alone) is what to keep once a cert
//                     comes back, the same as E/P/F's own
//                     ~/.config/.cloudflare-job-fair/<name>/ layout.

import { execFile } from 'node:child_process' // {{{1
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { Keypair } from '@stellar/stellar-sdk'
import WebSocket from 'ws'
import { generate_keypair } from '../../../../daeh/lib/sdk.js'
import { job } from '../../../../daeh/lib/job.ts'
import { buyGrant } from './gate.js'

const execFileP = promisify(execFile)

//function makeOutbox () {{{1
/** Same one-shot outbox as run.js's own -- see its comment. */
function makeOutbox () {
  const queue = []
  let pending
  return {
    push (line) {
      if (pending) { const resolve = pending; pending = undefined; resolve(line); }
      else queue.push(line);
    },
    receive () {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise(resolve => { pending = resolve });
    },
  };
}

//async function generateCsr (pk, cn, dir) {{{1
/** Generates a fresh TLS keypair + CSR locally -- OU set to the
 * Requester's own Stellar PK, the same convention E/P/F's own certs use
 * (see ccddh.md's Pi4b (F) runbook). The private key never leaves `dir`. */
async function generateCsr (pk, cn, dir) {
  await fs.mkdir(dir, { recursive: true })
  const keyPath = path.join(dir, 'certificate.key')
  const csrPath = path.join(dir, 'certificate.csr')
  await execFileP('openssl', [
    'req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', csrPath,
    '-subj', `/C=US/ST=Florida/L=Aventura/O=Kloud Of Trust QA/OU=${pk}/CN=${cn}`,
  ])
  return { keyPath, csrPath, csr: await fs.readFile(csrPath, 'utf-8') };
}

function restoreEnv (prev) { // {{{1
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

//export async function requestJoin (...) {{{1
/** The join Use Case's Requester-side flow: buys access to `issuerPk`'s
 * 'join' gate (temporarily pointing gate.js's own env vars at it, then
 * restoring them -- not safe to call concurrently with itself or with
 * another buyGrant() user in the same process, fine for this script's
 * one-request-at-a-time use), then sends {kind, csr, network, email} and
 * returns the Agent's parsed JSON reply. */
export async function requestJoin ({
  // One asset per Job (ccddh.md): 'JOIN' is this Job's own fixed selector,
  // unlike the issuer PK (which legitimately varies per JA), so it
  // defaults here rather than falling through to gate.js's generic 'TGA'.
  // This also closes round 35's "accepted sharp edge" -- forwarding no
  // longer needs JOIN_ROOT_ASSET_CODE set at all to get this right.
  issuerPk, wsUrl = 'wss://qa.ws.tg.kloudoftrust.org/ja', assetCode = 'JOIN', price,
  kind = 'cert', csr, network, email, matchTimeoutMs, onLog = () => {},
}) {
  const prev = {
    TG_ISSUER_PK: process.env.TG_ISSUER_PK,
    TG_ASSET_CODE: process.env.TG_ASSET_CODE,
    TG_PRICE: process.env.TG_PRICE,
  }
  process.env.TG_ISSUER_PK = issuerPk
  process.env.TG_ASSET_CODE = assetCode
  if (price) process.env.TG_PRICE = price
  let kp
  try {
    kp = await buyGrant(onLog)
  } finally {
    restoreEnv(prev)
  }
  onLog('gate grant confirmed')

  const actor = {
    app: 'jr', iss: { name: 'jr', pk: kp.publicKey() }, sk: kp.secret(), WebSocket, wsArgs: [wsUrl],
  }
  const outbox = makeOutbox()
  outbox.push(JSON.stringify({ kind, csr, network, email }))
  outbox.push('context.job.stdin.end()') // sentinel -- see daeh/lib/job.ts's indataEOD handling

  const gen = job(actor, { aud: 'join', label: 'Join', outbox, matchTimeoutMs })
  let reply, jobError
  let step = await gen.next()
  while (!step.done) {
    const event = step.value
    if (event.type === 'message') reply = JSON.parse(event.payload.sub)
    else if (event.type === 'error') jobError = event.error
    step = await gen.next()
  }
  if (jobError) throw jobError;
  if (!reply) throw new Error('requestJoin(): no reply received');
  return reply;
}

async function main () { // {{{1
  const issuerPk = process.env.TG_ISSUER_PK
  if (!issuerPk) throw new Error('TG_ISSUER_PK must be set (the target JAs own Stellar public key)');
  const email = process.env.JOIN_EMAIL
  if (!email) throw new Error('JOIN_EMAIL must be set (where the issued cert should be sent)');
  const network = process.env.JOIN_NETWORK ?? 'testnet'

  if (!process.env.TG_JR_SK) { // {{{2 see this file's own header: setting
    // this *before* buyGrant() runs is what unifies the CSR/OU identity
    // with the gate-trade identity, the same stable-keypair pattern sh's
    // E/P/F already use.
    const [sk] = (await generate_keypair()).split(' ')
    process.env.TG_JR_SK = sk
  } // }}}2
  const pk = Keypair.fromSecret(process.env.TG_JR_SK).publicKey()

  const cn = process.env.JOIN_CN ?? `join-${randomUUID().slice(0, 8)}`
  const dir = process.env.JOIN_CERT_DIR ?? await fs.mkdtemp(path.join(os.tmpdir(), 'join-'))
  const { keyPath, csrPath, csr } = await generateCsr(pk, cn, dir)
  console.log(`[join] generated CSR for ${pk} at ${csrPath} (private key: ${keyPath})`)

  const reply = await requestJoin({
    issuerPk,
    wsUrl: process.env.TG_WS_URL,
    csr, network, email,
    matchTimeoutMs: Number(process.env.TG_MATCH_TIMEOUT_MS ?? 30_000),
    onLog: line => console.log('[join] gate:', line),
  })
  console.log('[join] Agent reply:', reply)
}

if (import.meta.url === `file://${process.argv[1]}`) { // {{{1
  main().catch(e => {
    console.error('[join] FAILED', e)
    process.exitCode = 1
  })
}
