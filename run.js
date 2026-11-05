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
//   JA_SK                    -- required: this Agent's own Stellar secret
//                               key (see gate.js) -- also this process's
//                               own Match/Relay signing key (see
//                               daeh/lib/sdk.js's generate_keypair);
//                               ungated dev/test mode (a separate
//                               TG_AGENT_SK/TG_AGENT_PK pair with no real
//                               Stellar identity behind it) is retired --
//                               every real caller already set both to the
//                               same keypair anyway.
//   TG_AGENT_NAME            -- optional, defaults to 'ja'
//   TG_WS_URL                -- optional, defaults to the qa deploy
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
//   TG_ASSET_CODE            -- required: this Job's own name, posted
//                               to /jobs once at startup (see
//                               postThisJob() below).
//   TG_DESCRIPTION           -- optional: posted to /jobs alongside
//                               TG_ASSET_CODE/JA_PK -- skipped entirely if
//                               unset, since jobs.ts requires a desc.

import { Keypair } from '@stellar/stellar-sdk' // {{{1
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { runJob } from '@amissine/daeh'
import { grant as gateGrant } from './gate.js'
import { mtlsAgent, mtlsOptions } from './mtls.mjs'
import { postJob } from '@amissine/daeh/post.mjs'
import { httpize } from '@amissine/daeh/util.mjs'

const sk = process.env.JA_SK // to sign/verify Match/Relay data, {{{1
// and to sign this identity's own gate trades (gate.js) -- one keypair,
// one identity, now that ungated dev/test mode (a separate, cert-less
// TG_AGENT_SK/TG_AGENT_PK pair) is retired: every real caller already
// set both pairs to the same keypair anyway.
if (!sk) {
  console.error('JA_SK must be set (see generate_keypair)')
  process.exit(1)
}

const assetCode = process.env.TG_ASSET_CODE // {{{1
// No more 'TGA' fallback -- every real caller already sets this
// explicitly (toll_gate_reset/calc/csr), so the old default only ever
// masked a caller that forgot to (caught live: an ad-hoc verification
// run that forgot SH_ASSET_CODE placed a real, meaningless 'TGA' sell
// offer instead of failing loudly).
if (!assetCode) {
  console.error('TG_ASSET_CODE must be set')
  process.exit(1)
}

// Derived once, here, rather than left for each caller to also set: {{{1
// it's inherited by every spawned job (job.ts's env = {...process.env}),
// and job-owner.mjs needs it to apply the Job Owners rule (ccddh.md):
// comparing itself against the configured owner's PK silently always
// came out false without this, since undefined never equals a real PK --
// every instance, including the real owner, concluded it wasn't the owner
// and forwarded to itself forever. Caught live: a real infinite loop,
// each pass a real Stellar trade, before this fix existed. Named JA_PK,
// not TG_ISSUER_PK -- this is just "which account is this", not an
// assertion about being anyone's real issuer (see the Job Owners round's
// own naming note).
const pk = Keypair.fromSecret(sk).publicKey()
process.env.JA_PK = pk

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
  // No more TG_MTLS_PK override: it existed only to borrow another real
  // identity's cert for "ja's own agent key," back when that was a
  // separate, rotating, never-CSR'd TG_AGENT_PK with nothing of its own
  // to present. That whole concept is retired -- pk (above) is now
  // always the same stable, real Stellar identity JA_SK names, which is
  // already a real, already-certified identity for every current caller
  // (E, JA2), so there's nothing left for an override to stand in for.
  wsArgs: [process.env.TG_WS_URL ?? 'wss://qa.ws.tg.kloudoftrust.org/ja', safeMtlsOptions(pk)],
}

const aud = assetCode.toLowerCase() // {{{1
// No more separate TG_AGENT_AUD -- every real caller already set it to
// exactly this (toll_gate_calc's own comment used to spell it out:
// "aud is just TG_ASSET_CODE's own lowercase form by convention now"),
// so this derives it instead of making every caller set two env vars
// in lockstep for one selection (which Job this same run.js/gate.js
// offers -- cnj.md's csr Job runs this same way with
// TG_ASSET_CODE=CSR; not run concurrently with echo yet, that needs
// this Agent to run two gate+job loops at once, a separate problem).

const offer = {
  aud,
  label: aud === 'csr' ? 'Csr' : aud === 'calc' ? 'Calc' : aud === 'sell' ? 'Sell'
       : aud === 'buyinvite' ? 'BuyInvite' : 'Echo',
  spawn,
  indataEOD: true, // jr signals 'context.job.stdin.end()' once it's sent its message
  matchTimeoutMs: Number(process.env.TG_MATCH_TIMEOUT_MS ?? 30_000),
  relayTimeoutMs: Number(process.env.TG_RELAY_TIMEOUT_MS ?? 30_000),
  onEvent: event => {
    console.log('[ja] onEvent', event)
  },
}

const log = line => console.log('[ja] gate', line)

//async function postThisJob () {{{1
/** Posts this Job's own entry to /jobs once, at startup -- the KoT Jobs
 * list (cnj.md) replacing register.js's own old auto-registration (round
 * "retiring the registry"). Best-effort, same posture safeMtlsOptions()
 * already has: no TG_DESCRIPTION, no cert for this PK, or the POST
 * itself failing (e.g. a stale/wrong cert) all just skip with a logged
 * reason -- a Job not showing up on the catalog page is never a reason
 * to stop selling it. Called once, not from inside the for(;;) loop
 * below: nothing about this entry changes between grants. */
async function postThisJob () {
  const desc = process.env.TG_DESCRIPTION
  if (!desc) { console.log('[ja] TG_DESCRIPTION not set -- skipping /jobs posting'); return; }
  const jobsUrl = new URL('/jobs', httpize(process.env.TG_WS_URL ?? 'wss://qa.ws.tg.kloudoftrust.org/ja'))
  try {
    await postJob({ jobsUrl, agent: mtlsAgent(process.env.JA_PK), entry: { name: assetCode, issuerPk: process.env.JA_PK, desc } })
    console.log(`[ja] posted ${assetCode}:${process.env.JA_PK} to /jobs`)
  } catch (err) {
    console.log(`[ja] /jobs posting skipped: ${err.message}`)
  }
}

await postThisJob()

console.log('[ja] waiting for a matched request...')
for (;;) {
  console.log('[ja] gate closed, waiting for a grant...')
  // No more op_underfunded -> restock() fallback here: that only ever
  // applied to a reseller (JI_PK set), restocking via RTOJ against the
  // real Owner's own join-server.mjs, since retired along with the rest
  // of RTOJ (join-server.mjs/compete.mjs/daeh/lib/rtoj.mjs all removed,
  // same round this restock() call itself was retired in). A reseller
  // selling out now just throws and crashes, same as any other
  // unrecoverable error here; Restart=always is the only safety net
  // left for it, same as it always was for everything else in this loop.
  await gateGrant(log)
  // Proof of Delivery, redefined (ccddh.md): the Requester pays the
  // gate asset back unilaterally once the Job is done (see jr/run.js),
  // not something this Agent builds or sends -- no prefix needed here
  // any more.
  const message = await runJob(actor, offer)
  console.log('[ja]', message)
}
