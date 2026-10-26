#!/usr/bin/env node

// tg/ja/public/run.js -- the Toll Gate's Job Agent: gates access to a {{{1
// trivial echo job. The whole point of `ja`/`jr` is proving the toll-gate
// wiring (gate -> tg/ws match -> grant -> job relay) works end to end
// against `daeh` directly -- not the job itself, which is deliberately
// nothing fancier than "echo whatever you sent me back to you" (see
// jobs/echo/Makefile). Run with cwd set to jobs/ (see ./jr/Makefile's own
// `compete` target) so daeh's spawn mode's `cwd: './${jobAd.aud}'` resolves
// to jobs/echo/.
//
// Promoted here from tg/ja/run.js (ccddh.md's "publish daeh, promote the
// Agent-offering flow" round): a standalone clone of this repo alone never
// had this file at all, so there was no way to actually *become* a
// competing Agent, only to *request* a Job (jr/) or run the join/peer
// BITs -- only daeh's own imports below needed to change (bare specifiers,
// resolved via node_modules now that daeh is npm-published), nothing else.
// tg/ja/run.js stays behind unchanged, still what Дід Alik's/JA2's own
// toll_gate_reset/toll_gate_calc services run.
//
// Env:
//   TG_AGENT_SK, TG_AGENT_PK -- this Agent's signing keypair (see
//                               daeh/lib/sdk.js's generate_keypair)
//   TG_AGENT_NAME            -- optional, defaults to 'ja'
//   TG_WS_URL                -- optional, defaults to the qa deploy
//   TG_ISSUER_SK             -- optional: this Agent's own Stellar secret
//                               key (see gate.js). If unset, gating is
//                               skipped entirely (dev/test convenience) --
//                               for real use this should always be set.
//   TG_MATCH_TIMEOUT_MS      -- optional, defaults to 30000: how long to
//                               wait, once granted, for a Requester to
//                               actually connect and match before giving
//                               up and reopening the gate (daeh's
//                               matchTimeoutMs). Bounds only the WS-match
//                               wait *after* a gate trade has already
//                               filled -- the trade itself (how long a
//                               sell offer sits open before anyone buys
//                               it) has no timeout, and shouldn't: a
//                               future CI-triggering use of this same
//                               mechanism (ccddh.md's postponed idea)
//                               depends on a dev's sell offer being able
//                               to sit open indefinitely, until they next
//                               push. This is a different, much shorter
//                               wait -- for a Job that's already been
//                               paid for, not yet matched.
//   TG_RELAY_TIMEOUT_MS      -- optional, defaults to 30000: how long to
//                               wait, once matched, for the Requester to
//                               actually send something before giving up
//                               (daeh's relayTimeoutMs -- "granted a Job,
//                               but it never actually starts").
//   mTLS                     -- optional, 'true' to present this Job
//                               Fair family's shared client cert on the
//                               WS connection (see ./mtls.mjs, reused
//                               from hx/jobs/run.js's own pattern).

import { Keypair } from '@stellar/stellar-sdk' // {{{1
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { runJob } from '@amissine/daeh'
import { grant as gateGrant } from './gate.js'
import { mtlsOptions } from './mtls.mjs'
import { buyRtoj } from '@amissine/daeh/rtoj.mjs'

const sk = process.env.TG_AGENT_SK // to sign/verify Match/Relay data {{{1
const pk = process.env.TG_AGENT_PK
if (!sk || !pk) {
  console.error('TG_AGENT_SK and TG_AGENT_PK must be set (see generate_keypair)')
  process.exit(1)
}

// Derived once, here, rather than left for each caller to also set: {{{1
// gate.js only ever reads TG_ISSUER_SK, so this identity's own public key
// otherwise doesn't exist anywhere in this process's own env -- but it's
// inherited by every spawned job (job.ts's env = {...process.env}), and
// join-agent.mjs needs it to apply the Job Owners rule (ccddh.md):
// comparing itself against the configured owner's PK silently always
// came out false without this, since undefined never equals a real PK --
// every instance, including the real owner, concluded it wasn't the owner
// and forwarded to itself forever. Caught live: a real infinite loop,
// each pass a real Stellar trade, before this fix existed. Named JA_PK,
// not TG_ISSUER_PK -- this is just "which account is this", not an
// assertion about being anyone's real issuer (see the Job Owners
// round's own naming note).
if (process.env.TG_ISSUER_SK) process.env.JA_PK = Keypair.fromSecret(process.env.TG_ISSUER_SK).publicKey()

//function safeMtlsOptions (pk) {{{1
/** mtlsOptions() throws (a real fs ENOENT) when mTLS=true but the named
 * PK has no cert file at all -- fine for a caller that genuinely expects
 * one (register.js's own try/catch exists for the same reason), but a
 * real competing Agent with no cert of its own at all (ccddh.md's
 * "publish daeh, promote the Agent-offering flow" round -- a self-service
 * reseller never goes through join/BIT2's own CSR flow) has nothing to
 * present and nothing to borrow either. Caught live: a real ENOENT crash
 * here, for exactly that case. */
function safeMtlsOptions (pk) {
  try { return mtlsOptions(pk) ?? {}; } catch { return {}; }
}

const actor = { // {{{1
  app: 'ja', // handshake JWT's sub -- unused here (only jr's own
  // actor.app carries meaning, per db's precedent, though the echo job
  // doesn't currently make use of it either way)
  iss: { agent: true, name: process.env.TG_AGENT_NAME ?? 'ja', pk },
  sk,
  WebSocket,
  // TG_MTLS_PK: optional override for whose cert to present -- this
  // identity's own TG_AGENT_PK by default, but ja's own agent key is
  // never CSR'd (no lasting cert to dedupe for a rotating identity, round
  // 38's call on scope), so it has nothing of its own to present. The
  // mTLS check only verifies a cert chains to Cloudflare's CA, not which
  // PK it names, so borrowing another real identity's cert here (e.g.
  // E's) is a correct, if temporary, stand-in until ja's own agent key
  // ever gets one issued.
  wsArgs: [process.env.TG_WS_URL ?? 'wss://qa.ws.tg.kloudoftrust.org/ja', safeMtlsOptions(process.env.TG_MTLS_PK)],
}

const aud = process.env.TG_AGENT_AUD ?? 'echo' // {{{1
// Overridable so join (ccddh.md's "The join Use Case and its BITs") can be
// tested in isolation against this same run.js/gate.js, aud:'join' instead
// of 'echo' -- not run concurrently with it yet (that needs this Agent to
// run two gate+job loops at once, a separate problem). Defaults to 'echo',
// unchanged from before this existed.

const offer = {
  aud,
  label: aud === 'join' ? 'Join' : aud === 'calc' ? 'Calc' : 'Echo',
  spawn,
  indataEOD: true, // jr signals 'context.job.stdin.end()' once it's sent its message
  matchTimeoutMs: Number(process.env.TG_MATCH_TIMEOUT_MS ?? 30_000),
  relayTimeoutMs: Number(process.env.TG_RELAY_TIMEOUT_MS ?? 30_000),
  onEvent: event => {
    console.log('[ja] onEvent', event)
  },
}

if (!process.env.TG_ISSUER_SK) { // {{{1
  console.log('[ja] TG_ISSUER_SK not set -- gating skipped (dev/test only)')
}

const log = line => console.log('[ja] gate', line)

//async function restock () {{{1
/** A reseller (TG_ASSET_ISSUER_PK set -- ccddh.md's RTOJ) only ever holds
 * as much of the real Job asset as it's actually RTOJ'd, unlike the real
 * issuer (gate.js's own default case), who can always sell more of its
 * own asset regardless of balance. Selling out hits this Stellar-level,
 * not application-level: gate.js's own sell() rejects with a real
 * TransactionFailedError, op_underfunded (caught live: JA3, resold out
 * after its one real unit, crashed here unhandled). Buys exactly one more
 * unit via the same RTOJ mechanism the join Use Case bootstraps into a
 * Job with -- the real Owner's own join-server.mjs already fills every
 * RTOJ offer it sees unconditionally, no special-casing needed for an
 * already-onboarded reseller restocking rather than a brand-new
 * applicant (see rtoj.mjs's own watchForResellers -- fixed this same
 * round so a repeat offer from an already-seen buyer isn't silently
 * dropped forever). */
async function restock () {
  const kp = Keypair.fromSecret(process.env.TG_ISSUER_SK)
  const ownerPk = process.env.TG_ASSET_ISSUER_PK ?? kp.publicKey()
  const assetCode = process.env.TG_ASSET_CODE ?? 'TGA'
  console.log(`[ja] out of stock -- restocking 1 ${assetCode} via RTOJ from ${ownerPk}`)
  await buyRtoj({ kp, ownerPk, assetCode, onLog: log })
}

console.log('[ja] waiting for a matched request...')
for (;;) {
  if (process.env.TG_ISSUER_SK) {
    console.log('[ja] gate closed, waiting for a grant...')
    try {
      await gateGrant(log)
    } catch (err) {
      const codes = err?.response?.data?.extras?.result_codes?.operations ?? []
      if (!codes.includes('op_underfunded')) throw err;
      await restock()
      continue; // retry gateGrant() now that there's real inventory again
    }
    // Proof of Delivery, redefined (ccddh.md): the Requester pays the
    // gate asset back unilaterally once the Job is done (see jr/run.js),
    // not something this Agent builds or sends -- no prefix needed here
    // any more.
  }
  const message = await runJob(actor, offer)
  console.log('[ja]', message)
}
