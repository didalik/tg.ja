#!/usr/bin/env node

// tg/ja/public/jr/sell.mjs -- the sell Job's Requester side (cnj.md): a {{{1
// JA that's already a JI (it owns some Job of its own) applies to resell
// another JI's Job too. Buys 1 unit of that JI's own SELL:<jiPk> asset
// (gate.js's own buyGrant(), an ordinary gate trade, same PoP every other
// Job already relies on), Matches under aud:'sell', sends
// {assetCode, requesterPk}, then waits -- there's no out-of-band status
// store here, unlike csr.mjs's own join-status poll: approval *is* a
// real Stellar payment of assetCode landing on this account, so this
// just watches for that directly (stellar.mjs's own pollForTrade, same
// primitive gate.js's grant() already relies on, just watching for a
// payment effect instead of a trade one).
//
// Establishes trust to assetCode:issuerPk *before* sending the request
// (see sellAndWait()) -- Stellar can't credit a payment to an account
// with no trustline for that asset yet, and nothing on the approving
// JI's own side (sell-approve.mjs) can create that trustline on this
// account's behalf. issuerPk is required precisely because of this: it
// has to be known up front, not just discovered from the JI's own reply.
//
// Env (direct CLI use):
//   JI_PK          -- required: the approving JI's own Stellar public
//                     key -- who SELL:<JI_PK> and assetCode:<issuerPk>
//                     both belong to today (the same JI issues both, see
//                     sell-approve.mjs's own realIssuerOf check); kept as
//                     a separate name from issuerPk below anyway, since
//                     cnj.md's own model allows a JI to resell someone
//                     *else's* asset later, at which point they'd differ.
//   SELL_ASSET_CODE -- required: which of the JI's own Jobs this
//                     requester wants to resell, e.g. 'CALC'
//   TG_ASSET_CODE  -- optional, defaults to 'SELL' -- the toll asset for
//                     the sell JR itself, distinct from SELL_ASSET_CODE
//   TG_PRICE       -- optional, defaults to '1'
//   TG_JR_SK, TG_GRANT_TIMEOUT_MS -- see gate.js
//   TG_WS_URL      -- optional, defaults to the qa deploy
//   TG_MATCH_TIMEOUT_MS -- optional, defaults to 30000
//   SELL_POLL_TIMEOUT_MS -- optional: give up waiting for the JI to act
//                     after this many ms (unset, the default, waits
//                     forever -- same "no fixed SLA on a human" posture
//                     csr.mjs's own CSR_POLL_TIMEOUT_MS has).
//
// Usage: node sell.mjs

import { Asset, Keypair } from '@stellar/stellar-sdk' // {{{1
import WebSocket from 'ws'
import { generate_keypair } from '@amissine/daeh/sdk.js'
import { job } from '@amissine/daeh'
import { effectsCursorNow, ensureFunded, server } from '@amissine/daeh/stellar.mjs'
import { buyGrant, trust } from './gate.js'

//function makeOutbox () {{{1
/** Same one-shot outbox as run.js's/csr.mjs's own -- see their comments. */
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

//export async function requestSell (...) {{{1
/** The sell Job's own Requester-side flow: buys 1 unit of the JI's own
 * SELL:<jiPk> asset (gate.js's own buyGrant()), then Matches under
 * aud:'sell' and sends {assetCode, requesterPk}, returning the Agent's
 * parsed JSON reply (always {status:'queued', id} -- see
 * ../../jobs/sell/sell.mjs). */
export async function requestSell ({
  kp, jiPk = process.env.JI_PK, assetCode = process.env.SELL_ASSET_CODE,
  wsUrl = 'wss://qa.ws.tg.kloudoftrust.org/jr', matchTimeoutMs, onLog = () => {},
}) {
  process.env.JI_PK = jiPk
  process.env.TG_ASSET_CODE ??= 'SELL'
  process.env.TG_JR_SK = kp.secret()
  await buyGrant(onLog)
  onLog(`gate grant confirmed on ${process.env.TG_ASSET_CODE}`)

  const actor = {
    app: 'jr', iss: { name: 'jr', pk: kp.publicKey() }, sk: kp.secret(), WebSocket, wsArgs: [wsUrl],
  }
  const outbox = makeOutbox()
  outbox.push(JSON.stringify({ assetCode, requesterPk: kp.publicKey() }))
  outbox.push('context.job.stdin.end()') // sentinel -- see daeh/lib/job.ts's indataEOD handling

  const gen = job(actor, { aud: 'sell', label: 'Sell', outbox, targetPk: jiPk, matchTimeoutMs })
  let reply, jobError
  let step = await gen.next()
  while (!step.done) {
    const event = step.value
    if (event.type === 'message') reply = JSON.parse(event.payload.sub)
    else if (event.type === 'error') jobError = event.error
    step = await gen.next()
  }
  if (jobError) throw jobError;
  if (!reply) throw new Error('requestSell(): no reply received');
  return reply;
}

//function pollForPayment (pk, since, matches, onFound, intervalMs = 5000) {{{1
/** daeh/lib/stellar.mjs's own pollForTrade can't be reused here despite
 * its generic-looking `matches` callback -- its own loop hardcodes
 * `effect.type === 'trade'` ahead of calling matches() at all (confirmed
 * live: a real approval payment landed, visible via a direct Horizon
 * effects query, but pollForTrade never reported it -- that line is
 * why). A small local copy, same shape, same Horizon REST polling
 * (Stellar's own effects stream has independently been observed flaky
 * for trades -- same posture applies here), just without that
 * trade-only assumption baked in. */
function pollForPayment (pk, since, matches, onFound, intervalMs = 5000) {
  let stopped = false
  let cursor = since
  ;(async () => {
    while (!stopped) {
      await new Promise(resolve => setTimeout(resolve, intervalMs))
      if (stopped) return;
      let records
      try {
        ;({ records } = await server.effects().forAccount(pk).cursor(cursor).order('asc').limit(50).call())
      } catch {
        continue; // transient REST hiccup -- just retry next tick
      }
      for (const effect of records) {
        cursor = effect.paging_token
        if (matches(effect)) {
          if (!stopped) onFound(effect);
          return;
        }
      }
    }
  })()
  return () => { stopped = true; };
}

//export async function sellAndWait (...) {{{1
/** The whole flow: establish trust to assetCode:issuerPk, buy SELL, Match
 * under 'sell', send the request, then wait for the JI's own real
 * payment to land (resolves with the amount paid) or, if
 * pollTimeoutMs is set, time out. On rejection, there's nothing to wait
 * for at all -- see sell-approve.mjs's own header -- so a rejected
 * request just times out the same way a no-invite csr request
 * "correctly" does; this is expected, not a bug, until reimbursement is
 * built (same deliberate gap csr.mjs already has). */
export async function sellAndWait ({
  kp, jiPk = process.env.JI_PK, issuerPk = jiPk, assetCode = process.env.SELL_ASSET_CODE,
  wsUrl = 'wss://qa.ws.tg.kloudoftrust.org/jr', matchTimeoutMs, pollTimeoutMs, onLog = () => {},
}) {
  const asset = new Asset(assetCode, issuerPk)
  // ensureFunded() is also what triggers stellar.mjs's own lazy init
  // (ensureInit() isn't exported) -- has to run before trust() touches
  // `server` directly, or it's still undefined (same thing invite.mjs's
  // own header already warns about, caught live here the same way).
  await ensureFunded(kp)
  await trust(kp, asset)
  onLog(`trusting ${assetCode}:${issuerPk}`)

  // Captured *before* requestSell(), not after: a human-reviewed
  // approval always lands long after this call returns, so the ordering
  // never mattered before -- but a DEMO_MODE JI (jobs/sell/sell.mjs's
  // own header) pays out *inside* the same spawned handler, before it
  // exits, which is before requestSell()'s own job() generator finishes
  // draining, which is before this call would otherwise run. Capturing
  // the cursor after the request in that case put it *past* the
  // payment, so the poll below could never find it (caught live: a real
  // payment landed, visible via a direct Horizon query, but this
  // reported "still pending" every time).
  const since = await effectsCursorNow(kp.publicKey())
  const reply = await requestSell({ kp, jiPk, assetCode, wsUrl, matchTimeoutMs, onLog })
  onLog(`Agent reply: ${JSON.stringify(reply)}`)
  if (reply.status !== 'queued') throw new Error(`sell job didn't queue this: ${JSON.stringify(reply)}`);

  onLog(`queued as ${reply.id} -- waiting for ${jiPk} to approve or reject...`)
  const matches = effect => effect.type === 'account_credited' &&
    effect.asset_code === assetCode && effect.asset_issuer === issuerPk

  return new Promise((resolve, reject) => {
    let settled = false
    const deadline = pollTimeoutMs ? setTimeout(() => {
      if (settled) return;
      settled = true; stop();
      reject(new Error(`sell: still pending after ${pollTimeoutMs}ms`));
    }, pollTimeoutMs) : undefined
    const stop = pollForPayment(kp.publicKey(), since, matches, effect => {
      if (settled) return;
      settled = true; clearTimeout(deadline)
      onLog(`approved -- received ${effect.amount} ${assetCode}`)
      resolve(effect.amount);
    })
  });
}

async function main () { // {{{1
  const jiPk = process.env.JI_PK
  if (!jiPk) throw new Error('JI_PK must be set (the approving JIs own Stellar public key)');
  const assetCode = process.env.SELL_ASSET_CODE
  if (!assetCode) throw new Error('SELL_ASSET_CODE must be set (which of the JIs own Jobs to resell)');

  if (!process.env.TG_JR_SK) {
    const [sk] = (await generate_keypair()).split(' ')
    process.env.TG_JR_SK = sk
  }
  const kp = Keypair.fromSecret(process.env.TG_JR_SK)

  const amount = await sellAndWait({
    kp, jiPk, assetCode,
    wsUrl: process.env.TG_WS_URL,
    matchTimeoutMs: Number(process.env.TG_MATCH_TIMEOUT_MS ?? 30_000),
    pollTimeoutMs: process.env.SELL_POLL_TIMEOUT_MS ? Number(process.env.SELL_POLL_TIMEOUT_MS) : undefined,
    onLog: line => console.log('[sell]', line),
  })
  console.log(`[sell] complete for ${kp.publicKey()} -- received ${amount} ${assetCode}`)
}

if (import.meta.url === `file://${process.argv[1]}`) { // {{{1
  main().catch(e => {
    console.error('[sell] FAILED', e)
    process.exitCode = 1
  })
}
