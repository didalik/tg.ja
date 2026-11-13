#!/usr/bin/env node

// tg/ja/public/jr/bridge.mjs -- the local bridge (dqad.md), driving the {{{1
// demo's own whole join sequence in one process: buy an invite from
// JA2, submit a CSR with that invite attached, buy the Owner's own
// ECHO inventory to resell, work out half the Owner's own current
// price, retrieve the Owner's whole tg/sh directory via `peer`, and
// spawn that snapshot's own run.js as a tracked child so the new
// identity's own echo is genuinely live. Every one of the first four
// steps reuses this same directory's own already-proven, exported
// functions (requestBuyInvite/csrAndWait/sellAndWait/requestPeer) --
// this file is the orchestration on top, not a new implementation of
// any of them.
//
// Embeds this submodule's own ../broker.mjs (startBroker()) directly --
// every one of those calls, and the spawned run.js itself, submit
// through it (see broker.mjs's own header). A plain local import, not a
// filesystem path into a required sibling clone: broker.mjs used to
// only exist in tg/sh (a *private* repo), reached here via SH_DIR --
// caught live, DEMO_GUIDE.md's own one-time setup was telling a real
// demo visitor to clone it, which fails for anyone but Дід Alik.
// broker.mjs is now a promoted copy here instead (same reason
// broker-client.mjs/find-pk.mjs already are), so this submodule stays
// genuinely independently cloneable -- tg/sh is still needed, but only
// later, and only ever reached live via a `peer` retrieval (see
// request-peer.mjs), never a git clone.
//
// No CORS/reachability-probe logic at all, on purpose: the demo page's
// own `csr` entry is just a plain link to this server's own `/` (a
// top-level navigation into a new tab, never subject to CORS the way a
// cross-origin fetch would be), opened only once this bridge is already
// running. An unreachable bridge just shows the browser's own ordinary
// connection-failed page in that tab; there's nothing for this file to
// detect or report about that case itself.
//
// Usage:
//   node bridge.mjs
//   (first, one time: clone didalik/tg.ja, npm install -- see
//   DEMO_GUIDE.md)
//
// Env:
//   SH_BROKER_PORT     -- optional, defaults to 8793 (see
//                        ../broker.mjs) -- this bridge's own embedded
//                        broker's port.
//   BRIDGE_PORT        -- optional, defaults to 8099.
//   TG_WS_URL          -- optional, defaults to the qa deploy's own /jr
//                        path.
//   DEMO_CERT_EMAIL    -- optional, defaults to 'demo@kloudoftrust.org'
//                        -- must match tg/ja/csr-approve.mjs's own
//                        default (or whatever it's overridden to) for
//                        the Owner's own side to recognize this as a
//                        demo-transient cert and auto-revoke it later.
//   TG_MATCH_TIMEOUT_MS, TG_GRANT_TIMEOUT_MS -- optional, see gate.js;
//                        applied to every gate trade this flow makes.

import { spawn as nodeSpawn } from 'node:child_process' // {{{1
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Keypair } from '@stellar/stellar-sdk'
import { generate_keypair } from '@amissine/daeh/sdk.js'
import { httpize } from '@amissine/daeh/util.mjs'
import { server } from '@amissine/daeh/stellar.mjs'
import { startBroker } from '../broker.mjs'
import { requestBuyInvite } from './buyinvite.mjs'
import { certDirFor, csrAndWait, generateCsr } from './csr.mjs'
import { sellAndWait } from './sell.mjs'
import { requestPeer } from './request-peer.mjs'

const BROKER_PORT = Number(process.env.SH_BROKER_PORT ?? 8793) // {{{1
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 8099)
const WS_URL = process.env.TG_WS_URL ?? 'wss://qa.ws.tg.kloudoftrust.org/jr'
const DEMO_CERT_EMAIL = process.env.DEMO_CERT_EMAIL ?? 'demo@kloudoftrust.org'
const MATCH_TIMEOUT_MS = Number(process.env.TG_MATCH_TIMEOUT_MS ?? 30_000)
const GRANT_TIMEOUT_MS = process.env.TG_GRANT_TIMEOUT_MS ? Number(process.env.TG_GRANT_TIMEOUT_MS) : undefined

let state = { status: 'idle', log: [] } // {{{1
const log = line => { console.log('[bridge]', line); state.log.push(line) }
// Auto-cleanup fallback (SESSION_TTL_MS): the pitch page below promises
// "cleaned up automatically, whether this ends cleanly or not" -- but
// the only thing that ever actually called cleanup() was an explicit
// /leave (the page's own pagehide beacon) or this process getting a
// SIGINT/SIGTERM. A tab that's just left open indefinitely (no pagehide
// ever fires) or silently lost (phone sleeps, browser's killed, the
// beacon never reaches this process) never triggered either one --
// caught live: a demo visitor's own left-open tab kept selling long
// after they'd walked away. currentSession, not a bare timer closure:
// each runJoinFlow() call owns its own {pk, children}, and the timer
// checks it's still the *current* one before acting, so a second join
// started after the first already finished can't have its own state
// torn down by the first one's stale timer.
const SESSION_TTL_MS = Number(process.env.BRIDGE_SESSION_TTL_MS ?? 15 * 60_000)
let currentSession = null

//async function issuerPkOf (assetName) {{{1
/** The real issuer's own PK for a given Job name, straight off the live
 * /jobs catalog -- never hardcoded, same "discover, don't hardcode"
 * posture tg/sh/jobs/echo/echo.mjs's own calcIssuerPk() already has.
 * CALC is JA2's own uniquely-issued asset; CSR is the Owner's -- using
 * those two specific names is how this file learns both PKs without
 * either ever being written down here. */
async function issuerPkOf (assetName) {
  const jobsUrl = new URL('/jobs', httpize(WS_URL))
  const res = await fetch(jobsUrl)
  if (!res.ok) throw new Error(`issuerPkOf: GET ${jobsUrl} -> ${res.status}`);
  const jobs = await res.json()
  const entry = jobs.find(j => j.name === assetName)
  if (!entry) throw new Error(`issuerPkOf: no ${assetName} entry posted to /jobs`);
  return entry.issuerPk;
}

//async function halfOfOwnersPrice (ownerPk, assetCode) {{{1
/** Reads the Owner's own current sell price for assetCode straight off
 * the DEX's own order book (dqad.md's step 8a: "that's the only place
 * a price actually lives"), halves it. Assumes ensureInit() has already
 * run by the time this is called (it has -- every step before this one
 * already touched `server` via ensureFunded() internally). */
async function halfOfOwnersPrice (ownerPk, assetCode) {
  const { records } = await server.offers().forAccount(ownerPk).call()
  const offer = records.find(o => o.selling.asset_code === assetCode && o.selling.asset_issuer === ownerPk)
  if (!offer) throw new Error(`${ownerPk} has no live ${assetCode} offer to halve the price of`);
  return (Number(offer.price) / 2).toString();
}

//function spawnJob (label, env) {{{1
/** Shared by spawnResaleEcho()/spawnOwnEcho() below: spawns the
 * just-retrieved tg/sh snapshot's own run.js with the given env, tracks
 * it in the caller's own session.children for cleanup(), and resolves
 * once its own stdout
 * shows its gate is actually open ("gate selling"), not merely that the
 * process started -- the same concrete signal tg/bit/Makefile's own
 * demo-echo BIT already waits for. Two separate OS processes, not two
 * offers sharing one -- each gets its own independent process.env from
 * the moment it's spawned, so daeh/lib/job.ts's own per-match env
 * snapshot (the reason tg/service.js's own multi-offer identities use
 * one process with explicit per-offer params instead -- see
 * tg/ja/gate.js's own grant() for that story) never comes up here at
 * all; both still submit through the one embedded broker regardless.
 *
 * Takes the whole session, not just its children array: the TTL (or an
 * explicit /leave) can fire *while* a slow step like csrAndWait()'s own
 * human-approval wait is still in progress, well before this spawn ever
 * happens -- cleanup() already ran, found no children yet, and won't
 * run again for this session. Without this check, a child spawned after
 * that point would never be visited by anything and would leak forever
 * -- caught live: the TTL fired mid-flow, the flow carried on anyway and
 * spawned two echoes afterward, and nothing ever stopped them. */
function spawnJob (label, shSnapshotDir, session, env) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn('node', ['../run.js'], {
      cwd: path.join(shSnapshotDir, 'jobs'),
      env: { ...process.env, ...env },
    })
    session.children.push(child)
    if (session.cleaned) { child.kill(); } // session was already torn down before this spawn landed -- don't let it outlive that
    let settled = false
    child.stdout.on('data', chunk => {
      const text = chunk.toString()
      for (const line of text.split('\n')) if (line.trim()) log(`[${label}] ${line.trim()}`);
      if (!settled && text.includes('gate selling')) { settled = true; resolve(); }
    })
    child.stderr.on('data', chunk => {
      for (const line of chunk.toString().split('\n')) if (line.trim()) log(`[${label}:err] ${line.trim()}`);
    })
    child.on('error', err => { if (!settled) { settled = true; reject(err); } })
    child.on('exit', code => {
      if (!settled) { settled = true; reject(new Error(`${label} process exited early (code ${code})`)); }
    })
  });
}

//async function spawnResaleEcho ({ kp, ownerPk, price, shSnapshotDir }) {{{1
/** Resells the Owner's own ECHO (JI_PK set to the Owner's own PK, not
 * this identity's) at half its price -- dqad.md's own design answer for
 * "a tracked child process, no JA". */
function spawnResaleEcho ({ kp, ownerPk, price, shSnapshotDir, session }) {
  return spawnJob('echo', shSnapshotDir, session, {
    SH_ISSUER_SK: kp.secret(),
    SH_ASSET_CODE: 'ECHO',
    JI_PK: ownerPk, // reselling, not issuing -- see tg/sh/gate.js's own header
    SH_PRICE: price,
    mTLS: 'true', // this identity now has a real cert, from csrAndWait() above
    SH_BROKER_PORT: String(BROKER_PORT),
    SH_WS_URL: WS_URL.replace('/jr', '/ja'), // this flow's own WS_URL is a jr path; run.js needs the matching /ja one
  });
}

//async function spawnOwnEcho ({ kp, shSnapshotDir }) {{{1
/** The demo user's own, separately self-issued echo (dqad.md's own
 * "implements and runs its own Job") -- JI_PK deliberately left unset,
 * so gate.js self-issues ECHO:<this identity's own PK> instead of
 * reselling the Owner's (spawnResaleEcho() above does that one): a
 * brand new, distinct Stellar asset, not the same one at a different
 * price. SH_DESCRIPTION posts it to /jobs under the same label
 * tg/bit/Makefile's own demo-echo BIT already uses for this exact
 * thing. Same jobs/echo/echo.mjs handler either way -- deterministic,
 * delegates any arithmetic in the request to JA2's own real calc Job
 * (ask-calc.mjs) -- nothing about self-issuing changes that; the gate's
 * own asset/issuer never reaches the job handler. */
function spawnOwnEcho ({ kp, shSnapshotDir, session }) {
  return spawnJob('own-echo', shSnapshotDir, session, {
    SH_ISSUER_SK: kp.secret(),
    SH_ASSET_CODE: 'ECHO',
    SH_DESCRIPTION: 'Demo Agent\'s own echo -- deterministic, pays calc for real arithmetic',
    mTLS: 'true',
    SH_BROKER_PORT: String(BROKER_PORT),
    SH_WS_URL: WS_URL.replace('/jr', '/ja'),
  });
}

//async function runJoinFlow () {{{1
/** The whole sequence, dqad.md's steps 5-9, start to finish. */
async function runJoinFlow () {
  // A previous session this bridge never got an explicit /leave or TTL
  // expiry for yet (e.g. a retry right after a 'failed' run) -- tear it
  // down now instead of leaking its children/local files forever.
  if (currentSession) cleanup(currentSession);
  state = { status: 'running', log: [] }
  const children = []
  try {
    const [sk, pk] = (await generate_keypair()).split(' ')
    const kp = Keypair.fromSecret(sk)
    state.pk = pk
    log(`new identity: ${pk}`)

    const session = { pk, children, cleaned: false }
    currentSession = session
    session.ttl = setTimeout(() => { if (currentSession === session) cleanup(session); }, SESSION_TTL_MS)

    const ja2Pk = await issuerPkOf('CALC')
    const ownerPk = await issuerPkOf('CSR')

    log('requesting an invite from JA2...')
    // delete, not just "let it default": requestBuyInvite()/csrAndWait()/
    // sellAndWait() each do process.env.TG_ASSET_CODE ??= '<their own
    // default>' -- correct for each one's original design (always run as
    // its own fresh CLI process, so TG_ASSET_CODE always starts unset),
    // wrong here, where all three run sequentially in this one long-lived
    // process: once one sets it, ??= never lets the next one's own
    // default apply. Caught live: a real "trusting buyInvite:<ownerPk>"
    // where "trusting CSR:<ownerPk>" should have been, because
    // requestBuyInvite()'s own 'buyInvite' was still sitting there.
    delete process.env.TG_ASSET_CODE
    const inviteReply = await requestBuyInvite({
      kp, ja2Pk, expiry: new Date(Date.now() + 3_600_000).toISOString(),
      wsUrl: WS_URL, matchTimeoutMs: MATCH_TIMEOUT_MS, onLog: log,
    })
    if (!inviteReply.invite) throw new Error(`invite denied: ${inviteReply.message}`);
    log('got a real, signed invite')

    log('generating a CSR and requesting a certificate...')
    delete process.env.TG_ASSET_CODE // see the same note above
    const dir = certDirFor(pk)
    const { csr } = await generateCsr(pk, `demo-${pk.slice(0, 8)}`, dir)
    // storeCert() (inside csrAndWait() below) reads this back to learn
    // which network/secret key this identity is -- written by csr.mjs's
    // own CLI main() in the file's original design, which this bridge
    // bypasses by calling generateCsr()/csrAndWait() directly. Same
    // content main() itself would have written.
    await fs.writeFile(path.join(dir, 'sidecar.json'), JSON.stringify({ network: 'testnet', sk }) + '\n')
    await csrAndWait({
      kp, ownerPk, wsUrl: WS_URL, csr, email: DEMO_CERT_EMAIL,
      invite: inviteReply.invite, paymentTx: inviteReply.paymentTx,
      matchTimeoutMs: MATCH_TIMEOUT_MS, onLog: log,
    })
    // generateCsr()/storeCert() (the latter inside csrAndWait() above)
    // are the only other writers of the local files cleanup() removes
    // (certDirFor(pk), the .sk file) -- if the TTL fires anywhere during
    // this step (most likely: it's the one step with an open-ended human
    // wait), cleanup() runs while some or none of those files exist yet,
    // and whatever generateCsr()/storeCert() write *after* that point
    // would otherwise never be removed by anything (spawnJob() has its
    // own version of this same check, for the same reason). Re-running
    // it here is a plain, idempotent re-removal, not a second "cleaned"
    // transition.
    if (session.cleaned) await cleanupLocalFiles(pk);
    log('you are now, briefly, a real Job Agent')

    log('buying the Owner\'s own echo inventory to resell...')
    delete process.env.TG_ASSET_CODE // see the same note above
    await sellAndWait({
      kp, jiPk: ownerPk, issuerPk: ownerPk, assetCode: 'ECHO',
      wsUrl: WS_URL, matchTimeoutMs: MATCH_TIMEOUT_MS, onLog: log,
    })
    // sellAndWait() -> sell.mjs's own requestSell() sets process.env.JI_PK =
    // jiPk as a side effect and never unsets it (correct for its own
    // original design: always a fresh CLI process). Left sitting there,
    // it leaks into spawnOwnEcho()'s child below via its own {...process.env}
    // spread, overriding that offer's deliberately-unset JI_PK and making
    // it resell the Owner's ECHO too instead of self-issuing its own --
    // caught live: both of this identity's own offers showed up selling
    // ECHO:<Owner's PK> on Horizon, not two distinct assets.
    delete process.env.JI_PK
    const price = await halfOfOwnersPrice(ownerPk, 'ECHO')
    log(`got real echo inventory -- reselling at ${price} XLM`)

    log('buying peer access, to retrieve a working copy of sh...')
    const shSnapshotDir = path.join(os.tmpdir(), `bridge-${pk.slice(0, 8)}`, 'sh-received')
    await requestPeer({
      kp, issuerPk: ownerPk, wsUrl: WS_URL, matchTimeoutMs: MATCH_TIMEOUT_MS, destDir: shSnapshotDir, onLog: log,
    })
    log('retrieved and verified')

    log('starting your resale of the Owner\'s own echo...')
    await spawnResaleEcho({ kp, ownerPk, price, shSnapshotDir, session })
    log('your resale is live -- try it from the Jobs list')

    log('implementing and starting your own, separately-issued echo...')
    try {
      await spawnOwnEcho({ kp, shSnapshotDir, session })
      log('your own echo is live too -- delegates arithmetic to JA2\'s real calc Job')
    } catch (err) {
      // Best-effort: the resale above is the demo's own required
      // deliverable, already live by this point -- a glitch standing up
      // this second, more experimental offer shouldn't sink the whole
      // flow.
      log(`your own echo failed to start, continuing anyway: ${err.message}`)
    }

    state.status = 'done'
  } catch (err) {
    log(`FAILED -- ${err.message}`)
    state.status = 'failed'
  }
}

//async function cleanupLocalFiles (pk) {{{1
/** Removes this identity's own local trace -- the cert/key directory
 * (certDirFor()'s own, the same one csrAndWait()'s storeCert() wrote),
 * and the Stellar SK/mainnet dirs by the same PK-keyed convention, if
 * either ever exists (this flow never writes to either today, but
 * removing something that was never there is a harmless no-op, and
 * it's one less thing to re-check if that ever changes). Scoped to
 * *this* identity's own PK only -- never a wholesale wipe of these
 * shared directories, which a real visitor's own machine could
 * already be using for something else entirely (another Stellar
 * project, a previous run of this same demo). Best-effort: a failed
 * removal here is logged, never thrown -- same posture every other
 * shutdown-time cleanup in this file already has. */
async function cleanupLocalFiles (pk) {
  const home = process.env.HOME
  const paths = [certDirFor(pk), `${home}/.config/.testnet/${pk}.sk`, `${home}/.config/.mainnet/${pk}`]
  for (const p of paths) {
    await fs.rm(p, { recursive: true, force: true }).catch(
      err => console.log(`[bridge] local cleanup of ${p} failed: ${err.message}`));
  }
}

async function cleanup (session) { // {{{1
  // session: whichever {pk, children, ttl} this call is for -- the
  // explicit /leave handler, the TTL timer above, and SIGINT/SIGTERM
  // below all pass in whatever they believe the live one to be.
  // Deliberately safe (and necessary) to call more than once for the
  // same session: session.cleaned is set here, synchronously, before
  // this function's first await, specifically so spawnJob() can check
  // it and kill-on-arrival a child that's spawned *after* this already
  // ran once (see spawnJob()'s own header) -- which means a later
  // cleanup() call (an explicit /leave arriving after the TTL already
  // fired, say) still needs to revisit session.children for anything
  // new since the last pass. child.killed guards against re-killing one
  // this function (or spawnJob()'s own check) already signalled; local
  // file removal below has no guard of its own at all, deliberately --
  // fs.rm(..., {force:true}) is already a safe no-op on a path that's
  // already gone, so there's no reason to track whether this already
  // ran, and every reason not to: anything written to those same paths
  // after an earlier cleanup() call (same risk spawnJob() guards against
  // for children -- see runJoinFlow()'s own explicit re-check right
  // after csrAndWait(), the one other writer of these paths) needs a
  // later call to actually remove it, not skip it because an earlier
  // call already "did" this.
  if (!session) return;
  session.cleaned = true
  clearTimeout(session.ttl)
  const exits = []
  for (const child of session.children) {
    if (child && !child.killed) {
      console.log('[bridge] cleaning up -- stopping a spawned echo')
      exits.push(new Promise(resolve => child.once('exit', resolve)))
      child.kill()
    }
  }
  // Waits for each child's own shutdown (cancelling its offer, retracting
  // its /jobs entry -- see tg/sh/run.js's own shutdown handler) to
  // actually finish before removing local files below, not just for the
  // signal to be sent -- that shutdown needs this identity's own cert to
  // authenticate the /jobs DELETE call, caught live getting pulled out
  // from under it (ENOENT) when this ran immediately after child.kill()
  // instead. 15s covers its own worst case (a 5s DELETE timeout plus up
  // to 5 1s-spaced retries in cancelOwnOffer()) with room to spare; a
  // child that still hasn't exited by then is logged, not waited on
  // forever.
  const timeout = new Promise(resolve => setTimeout(resolve, 15_000))
  if (exits.length > 0) {
    const winner = await Promise.race([Promise.all(exits).then(() => 'exited'), timeout])
    if (winner !== 'exited') console.log('[bridge] a spawned echo did not exit within 15s -- cleaning up local files anyway');
  }
  if (session.pk) await cleanupLocalFiles(session.pk);
}
process.on('SIGINT', () => { cleanup(currentSession).then(() => process.exit(0)); })
process.on('SIGTERM', () => { cleanup(currentSession).then(() => process.exit(0)); })

//const PITCH_HTML = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"> // {{{1
const PITCH_HTML = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Become a Job Agent</title></head><body style="font-family: sans-serif; max-width: 640px; margin: 2em auto; padding: 0 1em">
<h2>Join the Kloud of Trust, for real</h2>
<p>This buys you a real invite, a real Cloudflare-issued certificate, real resellable inventory of
the Owner's own <code>echo</code> Job at half its price, and spins up your own live <code>echo</code>
Agent -- all real Stellar transactions, nothing mocked. Your new identity is disposable: it's
cleaned up automatically within ${Math.round(SESSION_TTL_MS / 60_000)} minutes at the latest, whether
this ends cleanly or not.</p>
<button id="go" style="font-size: 1.2em; padding: 0.5em 1em">Join now</button>
<pre id="log" style="background:#111;color:#0f0;padding:1em;white-space:pre-wrap;min-height:4em"></pre>
<script>
const btn = document.getElementById('go'), log = document.getElementById('log');
btn.onclick = async () => {
  btn.disabled = true;
  await fetch('/join', { method: 'POST' });
  const poll = setInterval(async () => {
    const s = await (await fetch('/status')).json();
    log.textContent = s.log.join('\\n');
    if (s.status !== 'running') { clearInterval(poll); btn.disabled = false; }
  }, 1000);
};
// Closing this tab (or navigating away) has to actually end the
// session, not just stop watching it -- a closed tab doesn't touch the
// Node process underneath at all on its own, which otherwise keeps
// running (and keeps selling) indefinitely. sendBeacon, not fetch: the
// browser guarantees it's sent even as the page is torn down, which an
// ordinary fetch() from an unload handler isn't.
window.addEventListener('pagehide', () => navigator.sendBeacon('/leave'));
</script></body></html>`

const bridgeServer = http.createServer((req, res) => { // {{{1
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PITCH_HTML)
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  } else if (req.method === 'POST' && req.url === '/join') {
    if (state.status === 'running') {
      res.writeHead(409, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'already running' }))
      return;
    }
    runJoinFlow()
    res.writeHead(202, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ started: true }))
  } else if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(state))
  } else if (req.method === 'POST' && req.url === '/leave') {
    // The pitch page's own pagehide beacon -- see its header comment.
    // Only tears down *this session's* own spawned echoes and local
    // identity files (cleanup()) -- NOT process.exit() on the bridge
    // server itself, which caught live would shut the whole bridge
    // down on every single tab close, leaving it unable to serve a
    // next visitor (or this same one, re-joining) at all. The bridge
    // server is long-running infrastructure; a session is not.
    res.writeHead(204)
    res.end()
    cleanup(currentSession)
  } else {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  }
})

startBroker({ port: BROKER_PORT }) // {{{1
bridgeServer.listen(BRIDGE_PORT, '127.0.0.1', () => {
  console.log(`[bridge] listening on http://localhost:${BRIDGE_PORT}/ -- leave this running`)
})
