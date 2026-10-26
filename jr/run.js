#!/usr/bin/env node

// tg/ja/public/jr/run.js -- the Toll Gate's Job Requester: does the gate {{{1
// trade, waits to be matched, sends one message, and prints back whatever
// `ja`'s echo job sends in reply -- the whole point is proving the
// toll-gate wiring (gate -> tg/ws match -> job relay) works
// end to end against `daeh` directly, not the job itself.
//
// Imports daeh as a bare specifier, resolved via node_modules (ccddh.md's
// "limited trust" round: daeh moved to its own repo, didalik/daeh,
// installed as a git+ssh dependency -- a plain npm symlink from k2's own
// root when run from inside this monorepo, same mechanism either way).
// jr is independently cloneable now, the same as db/public/requestor --
// this file's own imports no longer assume a fixed relative depth into a
// surrounding checkout.
//
// Env:
//   TG_WS_URL          -- optional, defaults to the qa deploy. Its origin
//                         (httpized -- see daeh/lib/util.mjs's httpize) is
//                         used to reach the one shared job catalog below;
//                         its own smName-shaped path is just the fallback
//                         connect target if discovery finds nothing.
//   TG_JR_NAME         -- optional, defaults to 'jr'
//   TG_ISSUER_PK       -- the Agent's Stellar public key (see gate.js).
//                         Optional -- if unset, discovered from the
//                         catalog instead (by TG_ASSET_CODE), which also
//                         supplies which smName to actually connect to.
//                         If *that's* also empty (nothing registered for
//                         that asset code), the gate trade is skipped
//                         entirely (dev/test only).
//   TG_GRANT_TIMEOUT_MS -- optional: cancel the DEX buy offer and give up if
//                         it doesn't fill within this long (see gate.js).
//   TG_MATCH_TIMEOUT_MS -- optional, defaults to 30000: give up (daeh's
//                         matchTimeoutMs) if never matched with an Agent
//                         within this long, once the gate trade (if any) has
//                         already gone through.

import WebSocket from 'ws' // {{{1
import { generate_keypair } from '@amissine/daeh/sdk.js'
import { job } from '@amissine/daeh'
import { httpize } from '@amissine/daeh/util.mjs'
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
  const [sk, pk] = (await generate_keypair()).split(' ')

  // One asset per Job, not a shared 'TGA' (ccddh.md) -- 'ECHO' is this
  // one's own fixed selector. Only a default: an explicit TG_ISSUER_PK
  // (bypassing the registry lookup below) still needs this, since the
  // registry's own entry.assetCode is what normally provides it instead.
  process.env.TG_ASSET_CODE ??= 'ECHO'

  // The original, smName-bearing URL -- the fallback connect target if
  // discovery below finds nothing (today's own "skip gating, still try
  // the connection" behavior -- a bare origin with no smName segment
  // would 500 the WS upgrade instead). Only ever overwritten on an actual
  // catalog hit, never discarded outright.
  let wsUrl = process.env.TG_WS_URL ?? 'wss://qa.ws.tg.kloudoftrust.org/ja'

  if (!process.env.TG_ISSUER_PK) {
    const origin = new URL(wsUrl).origin // ws(s): is a WHATWG "special"
    // scheme, so .origin is meaningful -- scheme+host+port, path dropped.
    const registryUrl = `${httpize(origin)}/catalog/registry?assetCode=${process.env.TG_ASSET_CODE}`
    const res = await fetch(registryUrl)
    if (res.ok) {
      const entries = await res.json() // always an array now (possibly empty), never 404
      if (entries.length > 0) {
        const entry = entries[0] // server-sorted cheapest-priced first
        process.env.TG_ISSUER_PK = entry.issuerPk
        process.env.TG_ASSET_CODE = entry.assetCode
        // The real asset to trust/buy, when this entry is a reseller's
        // own (gate.js's own mirror-image env var) -- without this,
        // gate.js falls back to trusting/buying entry.issuerPk's own
        // self-issued look-alike instead of the real thing it actually
        // sells (caught live, ja.mjs: discovery found a reseller's real
        // entry correctly, but the trade never filled -- wrong asset).
        if (entry.realIssuerPk) process.env.TG_ASSET_ISSUER_PK = entry.realIssuerPk
        if (entry.price) process.env.TG_PRICE = entry.price
        wsUrl = `${origin}/${entry.smName}` // the catalog, not wsUrl's own old path, says where to connect
        console.log('[jr] registry: found', entry)
      } else {
        console.log(`[jr] registry: no entry (${registryUrl})`)
      }
    } else {
      console.log(`[jr] registry: lookup failed (${registryUrl} -> ${res.status})`)
    }
  }

  const actor = {
    app: 'jr',
    iss: { name: process.env.TG_JR_NAME ?? 'jr', pk },
    sk,
    WebSocket,
    wsArgs: [wsUrl],
  }

  let requesterKp
  if (process.env.TG_ISSUER_PK) {
    requesterKp = await buyGrant(line => console.log('[jr] gate:', line))
    console.log('[jr] gate grant confirmed')
  } else {
    console.log('[jr] TG_ISSUER_PK not set (directly or via the registry) -- gating skipped (dev/test only)')
  }

  const outbox = makeOutbox()
  outbox.push('hello from jr')
  outbox.push('context.job.stdin.end()') // sentinel -- see daeh/lib/job.ts's indataEOD handling

  const gen = job(actor, {
    aud: 'echo', label: 'Echo', outbox,
    matchTimeoutMs: Number(process.env.TG_MATCH_TIMEOUT_MS ?? 30_000),
  })
  let jobError // set on a daeh 'error' event (e.g. match/relay timeout) -- thrown below
  // instead of just logged, so an unattended run (the nightly BIT) actually
  // exits non-zero on failure rather than silently "succeeding".
  let step = await gen.next()
  while (!step.done) {
    const event = step.value
    if (event.type === 'open') {
      console.log('[jr] Connected, waiting to be matched with an Agent...')
    } else if (event.type === 'matched') {
      console.log('[jr] Matched -- sending the echo request...')
    } else if (event.type === 'output') {
      console.log('[jr] sent:', event.line)
    } else if (event.type === 'message') {
      console.log('[jr] echo reply:', event.payload.sub)
    } else if (event.type === 'error') {
      console.error('[jr] job error:', event.error)
      jobError = event.error
    }
    step = await gen.next()
  }
  console.log('[jr]', step.value.message)
  if (jobError) throw jobError;

  // Proof of Delivery, redefined (ccddh.md): pay the gate asset back to
  // the Agent now that the Job is done, unilaterally -- no XDR from the
  // Agent needed, just our own keypair and its already-known public key.
  if (requesterKp) {
    const txId = await payBack(requesterKp)
    console.log(`PoD-TXID: ${txId}`) // bare, no [jr] prefix -- meant to be parsed later
  }
}

main().catch(e => { // {{{1
  console.error('[jr] FAILED', e)
  process.exitCode = 1
})
