#!/usr/bin/env node

// tg/ja/public/jr/run.js -- the Toll Gate's generic Job Requester (ccddh.md's {{{1
// "retiring the registry" round): does the gate trade, waits to be matched,
// sends one message, and prints back whatever the Agent's own job sends in
// reply -- the whole point is proving the toll-gate wiring (gate -> tg/ws
// match -> job relay) works end to end against `daeh` directly, not the
// job itself. Generic now, not echo-specific: TG_ASSET_CODE picks the Job
// (aud is just its own lowercase form -- ECHO -> echo, CALC -> calc, ...,
// the convention every Job name already follows), so this one script
// drives any Job a caller already knows JI_PK/TG_ASSET_CODE for.
//
// Imports daeh as a bare specifier, resolved via node_modules (ccddh.md's
// "limited trust" round: daeh moved to its own repo, didalik/daeh,
// installed as a git+ssh dependency -- a plain npm symlink from k2's own
// root when run from inside this monorepo, same mechanism either way).
// jr is independently cloneable now, the same as db/public/requestor --
// this file's own imports no longer assume a fixed relative depth into a
// surrounding checkout.
//
// Connects to a fixed /jr path now, not one smName per app (ccddh.md's
// "collapse to one shared WS room" round already made that purely
// cosmetic server-side; every JA, symmetrically, now connects to a fixed
// /ja -- see tg/ja/run.js). Finding *who* to trade with no longer needs a
// catalog either: JI_PK names the Job's own real issuer directly, and
// Stellar's own DEX picks up whichever account -- the real issuer or any
// reseller holding real, fungible inventory of that exact asset -- has
// the best current price, with no discovery step of its own at all.
//
// Env:
//   TG_WS_URL          -- optional, defaults to the qa deploy's own /jr path.
//   TG_JR_NAME         -- optional, defaults to 'jr'
//   TG_ASSET_CODE      -- optional, defaults to 'ECHO'
//   JI_PK              -- required (no gating at all if unset -- dev/test only)
//   JA_PK              -- optional: pins the WS Match to this specific
//                         Agent instead of JI_PK -- set this if you already
//                         know you're buying from a reseller, not the real
//                         issuer; buyGrant() also sets it itself, from the
//                         trade's own real counterparty, once the trade
//                         actually fills (see gate.js).
//   TG_GRANT_TIMEOUT_MS -- optional: cancel the DEX buy offer and give up if
//                         it doesn't fill within this long (see gate.js).
//   TG_MATCH_TIMEOUT_MS -- optional, defaults to 30000: give up (daeh's
//                         matchTimeoutMs) if never matched with an Agent
//                         within this long, once the gate trade (if any) has
//                         already gone through.

import WebSocket from 'ws' // {{{1
import { generate_keypair } from '@amissine/daeh/sdk.js'
import { job } from '@amissine/daeh'
import { buyGrant, payBack } from './gate.js'

//function makeOutbox () {{{1
/** A one-shot outbox: queue up the lines to send ahead of time, pumpOutbox
 * (inside daeh's job()) pulls them one at a time once matched. Blocks
 * forever once the queue is drained -- fine here, there's nothing more to
 * say after the sentinel. */
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

async function main () { // {{{1
  const [sk, pk] = (await generate_keypair()).split(' ') // {{{2

  // One asset per Job, not a shared 'TGA' (ccddh.md) -- 'ECHO' is this
  // one's own fixed selector, overridden by an explicit TG_ASSET_CODE
  // for any other Job.
  process.env.TG_ASSET_CODE ??= 'ECHO'

  const wsUrl = process.env.TG_WS_URL ?? 'wss://qa.ws.tg.kloudoftrust.org/jr' // {{{2

  const actor = { // {{{2
    app: 'jr',
    iss: { name: process.env.TG_JR_NAME ?? 'jr', pk },
    sk,
    WebSocket,
    wsArgs: [wsUrl],
  }

  let requesterKp
  if (process.env.JI_PK) {
    requesterKp = await buyGrant(line => console.log('[jr] gate:', line))
    const seller = process.env.JA_PK == process.env.JI_PK ? 'issuer' : 'reseller'
    console.log(`[jr] gate granted by ${seller}`)
  } else {
    console.log('[jr] JI_PK not set -- gating skipped (dev/test only)')
  }

  const outbox = makeOutbox() // {{{2
  outbox.push('hello from jr')
  outbox.push('context.job.stdin.end()') // sentinel -- see daeh/lib/job.ts's indataEOD handling

  const label = process.env.TG_ASSET_CODE // {{{2
  const aud = label.toLowerCase()
  const gen = job(actor, {
    aud, label, outbox,
    // Which specific Agent's offer to match -- the one this Requester's
    // own gate trade just paid (JA_PK, when a reseller's own trade set it
    // differently from JI_PK; otherwise they're the same account), not
    // just any offer sharing this aud (see daeh/lib/sdk.js's
    // MRT.setTarget -- ccddh.md's Match-pairing round).
    targetPk: process.env.JA_PK ?? process.env.JI_PK,
    matchTimeoutMs: Number(process.env.TG_MATCH_TIMEOUT_MS ?? 30_000),
  })
  let jobError // set on a daeh 'error' event (e.g. match/relay timeout) -- thrown below
  // instead of just logged, so an unattended run (the nightly BIT) actually
  // exits non-zero on failure rather than silently "succeeding".
  let step = await gen.next() // {{{2
  while (!step.done) {
    const event = step.value
    if (event.type === 'open') { // {{{3
      console.log('[jr] Connected, waiting to be matched with an Agent...')
    } else if (event.type === 'matched') { // {{{3
      console.log(`[jr] Matched -- sending the ${aud} request...`)
    } else if (event.type === 'output') { // {{{3
      console.log('[jr] sent:', event.line)
    } else if (event.type === 'message') { // {{{3
      console.log(`[jr] ${aud} reply:`, event.payload.sub)
    } else if (event.type === 'error') { // {{{3
      console.error('[jr] job error:', event.error)
      jobError = event.error
    } // }}}3
    step = await gen.next()
  }
  console.log('[jr]', step.value.message)
  if (jobError) throw jobError;

  // Proof of Delivery, redefined (ccddh.md): pay the gate asset back to {{{2
  // the Agent now that the Job is done, unilaterally -- no XDR from the
  // Agent needed, just our own keypair and its already-known public key.
  if (requesterKp) {
    const txId = await payBack(requesterKp)
    console.log(`PoD-TXID: ${txId}`) // bare, no [jr] prefix -- meant to be parsed later
  } // }}}2
}

main().catch(e => { // {{{1
  console.error('[jr] FAILED', e)
  process.exitCode = 1
})
