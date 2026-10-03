#!/usr/bin/env node

// tg/ja/public/jr/run.js -- the Toll Gate's Job Requester: does the gate {{{1
// trade, waits to be matched, sends one message, and prints back whatever
// `ja`'s echo job sends in reply -- the whole point is proving the
// toll-gate wiring (gate -> tg/ws match -> job relay) works
// end to end against `daeh` directly, not the job itself.
//
// Imports daeh directly by relative path -- daeh isn't published yet, but
// we're all in the same monorepo checkout right now, so there's no reason
// to hand-copy it the way db/public/requestor's lib/ files still do. Once
// daeh is npm-published, this becomes a one-line import-specifier change,
// not a re-copy. (This does mean jr isn't independently cloneable the way
// db/public/requestor is, for now -- a deliberate, temporary tradeoff:
// proving daeh's interfaces via a real consumer is this round's actual
// goal, not re-solving "standalone clone" for jr too.)
//
// Env:
//   TG_WS_URL          -- optional, defaults to the qa deploy. Also used,
//                         httpized (see daeh/lib/util.mjs's httpize), to
//                         derive the registry URL below -- a browser-based
//                         jr (planned, not yet built) would do the exact
//                         same derivation from whatever ws(s):// URL it
//                         already has, no separate file/URL needed.
//   TG_JR_NAME         -- optional, defaults to 'jr'
//   TG_ISSUER_PK       -- the Agent's Stellar public key (see gate.js).
//                         Optional -- if unset, fetched from the registry
//                         instead. If *that's* also empty (nothing
//                         registered), the gate trade is skipped entirely
//                         (dev/test only).
//   TG_GRANT_TIMEOUT_MS -- optional: cancel the DEX buy offer and give up if
//                         it doesn't fill within this long (see gate.js).
//   TG_MATCH_TIMEOUT_MS -- optional, defaults to 30000: give up (daeh's
//                         matchTimeoutMs) if never matched with an Agent
//                         within this long, once the gate trade (if any) has
//                         already gone through.

import WebSocket from 'ws' // {{{1
import { generate_keypair } from '../../../../daeh/lib/sdk.js'
import { job } from '../../../../daeh/lib/job.ts'
import { httpize } from '../../../../daeh/lib/util.mjs'
import { buyGrant, submitPod } from './gate.js'

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
  const [sk, pk] = (await generate_keypair.call(globalThis.crypto.subtle)).split(' ')

  const wsUrl = process.env.TG_WS_URL ?? 'wss://qa.ws.tg.kloudoftrust.org/ja'
  const actor = {
    app: 'jr',
    iss: { name: process.env.TG_JR_NAME ?? 'jr', pk },
    sk,
    WebSocket,
    wsArgs: [wsUrl],
  }

  if (!process.env.TG_ISSUER_PK) {
    const registryUrl = `${httpize(wsUrl)}/registry`
    const res = await fetch(registryUrl)
    if (res.ok) {
      const entry = await res.json()
      process.env.TG_ISSUER_PK = entry.issuerPk
      if (entry.assetCode) process.env.TG_ASSET_CODE = entry.assetCode
      if (entry.price) process.env.TG_PRICE = entry.price
      console.log('[jr] registry: found', entry)
    } else {
      console.log(`[jr] registry: no entry (${registryUrl} -> ${res.status})`)
    }
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
  let podXdr // the Agent's first relayed message, a 'POD:'-prefixed clawback XDR -- see tg/ja/run.js
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
      let sub = event.payload.sub
      if (!podXdr && sub.startsWith('POD:')) {
        // The relay is a raw byte stream with no message framing of its
        // own (confirmed live: jr's own two pushed lines, and even this
        // PoD prefix, can arrive concatenated into a single chunk rather
        // than as separate messages) -- XDR is base64, which can't contain
        // a literal newline, so the prefix's own trailing \n is what
        // actually delimits it from anything arriving glued onto the same
        // chunk, not the chunk boundary itself.
        const nl = sub.indexOf('\n')
        podXdr = nl === -1 ? sub.slice(4) : sub.slice(4, nl)
        console.log('[jr] received PoD XDR')
        sub = nl === -1 ? '' : sub.slice(nl + 1)
      }
      if (sub) console.log('[jr] echo reply:', sub)
    } else if (event.type === 'error') {
      console.error('[jr] job error:', event.error)
      jobError = event.error
    }
    step = await gen.next()
  }
  console.log('[jr]', step.value.message)
  if (jobError) throw jobError;

  if (podXdr && requesterKp) {
    const txId = await submitPod(podXdr, requesterKp)
    console.log(`PoD-TXID: ${txId}`) // bare, no [jr] prefix -- meant to be parsed later
  }
}

main().catch(e => { // {{{1
  console.error('[jr] FAILED', e)
  process.exitCode = 1
})
