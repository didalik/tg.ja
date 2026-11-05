#!/usr/bin/env node

// tg/ja/public/jr/buyinvite.mjs -- the buyinvite Job's Requester side {{{1
// (dqad.md's step 5): the "local bridge"'s own first move when a demo
// user wants to join -- asks JA2 for a signed invite for its own PK
// (self-requesting: applicantPk is always this script's own kp, not a
// third party), then waits for JA2's own real reply -- either
// {invite, paymentTx} or {status:'denied', message}.
//
// Unlike jr/sell.mjs's own wait, there's no separate Stellar-effect poll
// needed here -- buyinvite's own Match/Relay reply *is* the whole
// answer (JA2's own handler only replies once it's actually done asking
// the Owner and, if allowed, signing+paying -- see
// tg/ja/jobs/buyinvite/buyinvite.mjs), not a separate out-of-band
// queue the way csr's own human-reviewed queue needs.
//
// Env (direct CLI use):
//   JI_PK          -- required: JA2's own Stellar public key (who's
//                     offering buyinvite)
//   BUYINVITE_EXPIRY -- optional, defaults to 1 hour from now
//   TG_ASSET_CODE  -- optional, defaults to 'buyInvite'
//   TG_PRICE       -- optional, defaults to '1'
//   TG_JR_SK, TG_GRANT_TIMEOUT_MS -- see gate.js
//   TG_WS_URL      -- optional, defaults to the qa deploy
//   TG_MATCH_TIMEOUT_MS -- optional, defaults to 30000
//
// Usage: node buyinvite.mjs

import { Keypair } from '@stellar/stellar-sdk' // {{{1
import WebSocket from 'ws'
import { generate_keypair } from '@amissine/daeh/sdk.js'
import { job } from '@amissine/daeh'
import { buyGrant } from './gate.js'

//function makeOutbox () {{{1
/** Same one-shot outbox as run.js's/csr.mjs's/sell.mjs's own -- see
 * their comments. */
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

//export async function requestBuyInvite (...) {{{1
/** The buyinvite Job's own Requester-side flow: buys 1 unit of JA2's
 * own buyInvite:<ja2Pk> asset (gate.js's own buyGrant()), then Matches
 * under aud:'buyinvite' and sends {applicantPk, expiry} (applicantPk
 * always this script's own kp -- a real end user is only ever asking
 * for an invite for *itself*), returning JA2's own parsed JSON reply. */
export async function requestBuyInvite ({
  kp, ja2Pk = process.env.JI_PK, expiry,
  wsUrl = 'wss://qa.ws.tg.kloudoftrust.org/jr', matchTimeoutMs, onLog = () => {},
}) {
  process.env.JI_PK = ja2Pk
  process.env.TG_ASSET_CODE ??= 'buyInvite'
  process.env.TG_JR_SK = kp.secret()
  await buyGrant(onLog)
  onLog(`gate grant confirmed on ${process.env.TG_ASSET_CODE}`)

  const actor = {
    app: 'jr', iss: { name: 'jr', pk: kp.publicKey() }, sk: kp.secret(), WebSocket, wsArgs: [wsUrl],
  }
  const outbox = makeOutbox()
  outbox.push(JSON.stringify({ applicantPk: kp.publicKey(), expiry }))
  outbox.push('context.job.stdin.end()') // sentinel -- see daeh/lib/job.ts's indataEOD handling

  const gen = job(actor, { aud: 'buyinvite', label: 'BuyInvite', outbox, targetPk: ja2Pk, matchTimeoutMs })
  let reply, jobError
  let step = await gen.next()
  while (!step.done) {
    const event = step.value
    if (event.type === 'message') reply = JSON.parse(event.payload.sub)
    else if (event.type === 'error') jobError = event.error
    step = await gen.next()
  }
  if (jobError) throw jobError;
  if (!reply) throw new Error('requestBuyInvite(): no reply received');
  return reply;
}

async function main () { // {{{1
  const ja2Pk = process.env.JI_PK
  if (!ja2Pk) throw new Error('JI_PK must be set (JA2s own Stellar public key)');
  const expiry = process.env.BUYINVITE_EXPIRY ?? new Date(Date.now() + 3600_000).toISOString()

  if (!process.env.TG_JR_SK) {
    const [sk] = (await generate_keypair()).split(' ')
    process.env.TG_JR_SK = sk
  }
  const kp = Keypair.fromSecret(process.env.TG_JR_SK)

  const reply = await requestBuyInvite({
    kp, ja2Pk, expiry,
    wsUrl: process.env.TG_WS_URL,
    matchTimeoutMs: Number(process.env.TG_MATCH_TIMEOUT_MS ?? 30_000),
    onLog: line => console.log('[buyinvite]', line),
  })
  console.log(`[buyinvite] reply: ${JSON.stringify(reply)}`)
  if (!reply.invite) throw new Error(`buyinvite denied: ${reply.message}`);
  console.log(`[buyinvite] got a real invite for ${kp.publicKey()}`)
}

if (import.meta.url === `file://${process.argv[1]}`) { // {{{1
  main().catch(e => {
    console.error('[buyinvite] FAILED', e)
    process.exitCode = 1
  })
}
