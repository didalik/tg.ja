#!/usr/bin/env node

// tg/ja/public/jr/csr.mjs -- the csr Job's Requester side (cnj.md), {{{1
// replacing the old join Use Case's RTOJ-based bootstrap entirely: csr
// is now a real, priced Job like echo/calc, bought with an ordinary gate
// trade (gate.js's own buyGrant()) against the Owner's own CSR:<ownerPk>
// asset, instead of an RTOJ trade against some *other*, unrelated Job's
// real asset. That trade is this flow's only proof of purchase now.
// Generates the Requester's own Stellar keypair and TLS CSR locally (the
// private key never leaves this process).
//
// One real behavior change this brings, worth being explicit about: the
// old RTOJ-against-ECHO trade doubled as both "prove you may join" *and*
// "here's your first unit of ECHO to resell" in one step (ccddh.md's
// RTOJ-redesign round). Buying CSR specifically no longer grants any
// resale inventory at all -- getting a cert and getting something to
// resell are two separate concerns now (cnj.md's own csr/sell split).
// compete.mjs's own first-time branch does a separate buyRtoj() call
// for that, right after this completes.
//
// Env (direct CLI use):
//   TG_ISSUER_PK   -- required: the real Job Owner's own Stellar public key
//   TG_ASSET_CODE  -- optional, defaults to 'CSR'
//   TG_PRICE       -- optional, defaults to '1' -- must match the Owner's
//   TG_JR_SK, TG_GRANT_TIMEOUT_MS -- see gate.js. Setting TG_JR_SK up
//                     front (rather than letting buyGrant() generate one)
//                     is what makes this script's own CSR/OU and the
//                     gate-trade identity the same stable keypair (round
//                     20's MRT design, same as sh's E/P/F). Only needed
//                     for the default mode -- `cert` mode (below) needs
//                     nothing from the environment at all, since it reads
//                     TG_JR_SK back from its own sidecar instead (a
//                     separate, later process invocation).
//   TG_WS_URL      -- optional, defaults to the qa deploy
//   TG_MATCH_TIMEOUT_MS -- optional, defaults to 30000
//   CSR_NETWORK    -- optional, defaults to 'testnet' -- Дід Alik's own
//                     bookkeeping only, not validated by any JA
//   CSR_EMAIL      -- required: where the issued cert should be sent
//   CSR_CN         -- optional, defaults to 'csr-<shortid>' -- the CSR's
//                     own CN field
//   CSR_CERT_DIR   -- optional, defaults to this identity's own
//                     ~/.config/.cloudflare-job-fair/<pk>/ (same PK-keyed
//                     layout as E/P/F's own certs, ccddh.md's "Keys and
//                     Certificates local storage, Redefined") -- where the
//                     generated keypair/CSR are written, and where `cert`
//                     mode (below) later looks for that same keypair once
//                     the signed certificate comes back.
//   CSR_NAME       -- optional: naming this identity once its cert lands
//                     (see storeCert()'s own header) -- replaces the old
//                     `node csr.mjs <name>` positional arg for this, now
//                     that a single `node csr.mjs` invocation does the
//                     whole thing (see Usage below); that positional
//                     form still exists, but only to select mainCert()
//                     over main() entirely, so it can no longer also
//                     carry a name for main()'s own use.
//   CSR_POLL_TIMEOUT_MS -- optional: give up waiting for a human to act
//                     on the queued request after this many ms (unset,
//                     the default, waits forever -- there's no fixed SLA
//                     on a human looking at something, same reasoning
//                     TG_GRANT_TIMEOUT_MS's own default has).
//
// Usage:
//   node csr.mjs         -- the whole flow in one invocation: generate a
//                                CSR, buy 1 CSR:<ownerPk> (the gate
//                                trade), Match under aud:'csr', send the
//                                CSR, then wait (no fixed timeout by
//                                default) for a human to approve or
//                                reject it via csr-approve.mjs
//                                (tg/ja/csr-approve.mjs, this box only --
//                                it automates submitting the CSR to
//                                Cloudflare and delivering the signed
//                                cert back, but still requires an
//                                explicit y/N from a real person first).
//                                Once approved, pays the CSR unit back
//                                (PoD, same as any other Job) and stores
//                                the cert itself -- see storeCert()'s own
//                                header for exactly what that does
//                                (cert.pem/cert.key, promoting this
//                                Requester to a full, stable,
//                                find-pk.mjs-resolvable identity). No
//                                second, separate invocation needed.
//   node csr.mjs <name>  -- the old, manual two-step flow's own second
//                                half, kept for anyone still mid-flow
//                                against a previous build: reads a PEM
//                                certificate pasted on stdin (e.g. after
//                                manually submitting the CSR to
//                                Cloudflare's own API) and hands it to
//                                storeCert(). <name> containing a space
//                                (e.g. "Дід Alik") gets its last word
//                                saved as an alias -- find-pk.mjs's own
//                                header explains why: a multi-word name
//                                can never safely sit in a Make ${TEST}
//                                target position, only an alias can.

import { execFile } from 'node:child_process' // {{{1
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { Keypair } from '@stellar/stellar-sdk'
import WebSocket from 'ws'
import { generate_keypair } from '@amissine/daeh/sdk.js'
import { job } from '@amissine/daeh'
import { httpize } from '@amissine/daeh/util.mjs'
import { buyGrant, payBack } from './gate.js'

const execFileP = promisify(execFile)

function readStdin () { // {{{1
  return new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.on('data', chunk => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    process.stdin.on('error', reject)
  });
}

//export function certDirFor (pk) {{{1
/** Where this identity's TLS keypair/CSR/cert live -- PK-keyed, same
 * layout mtls.mjs's own CERT_BASE uses, so a cert stored here needs no
 * further wiring to become usable. Shared by main() (CSR generation) and
 * mainCert() (storing the signed cert later) so both land in the exact
 * same directory for the same identity. Exported so compete.mjs can check
 * whether an identity already has a real cert before deciding whether it
 * needs to get one first. */
export function certDirFor (pk) {
  return process.env.CSR_CERT_DIR ?? `${process.env.HOME}/.config/.cloudflare-job-fair/${pk}`;
}

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

//export async function generateCsr (pk, cn, dir) {{{1
/** Generates a fresh TLS keypair + CSR locally -- OU set to the
 * Requester's own Stellar PK, the same convention E/P/F's own certs use
 * (see ccddh.md's Pi4b (F) runbook). The private key never leaves `dir`.
 * Exported so compete.mjs can generate its own CSR when it needs one. */
export async function generateCsr (pk, cn, dir) {
  await fs.mkdir(dir, { recursive: true })
  const keyPath = path.join(dir, 'cert.key')
  const csrPath = path.join(dir, 'cert.csr')
  await execFileP('openssl', [
    'req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', csrPath,
    '-subj', `/C=US/ST=Florida/L=Aventura/O=Kloud Of Trust QA/OU=${pk}/CN=${cn}`,
  ])
  return { keyPath, csrPath, csr: await fs.readFile(csrPath, 'utf-8') };
}

//export async function requestCsr (...) {{{1
/** The csr Job's own Requester-side flow: buys 1 unit of the Owner's own
 * CSR:<ownerPk> asset (gate.js's own buyGrant(), an ordinary gate trade
 * -- this is the only proof of purchase this flow gets now, no RTOJ
 * involved at all), then Matches under aud: 'csr' and sends
 * {csr, network, email}, returning the Agent's parsed JSON reply
 * alongside the Stellar keypair the gate trade used (needed later for
 * payBack() once/if the cert is actually issued). */
export async function requestCsr ({
  kp, ownerPk, wsUrl = 'wss://qa.ws.tg.kloudoftrust.org/ja',
  csr, network, email, matchTimeoutMs, onLog = () => {},
}) {
  process.env.TG_ISSUER_PK = ownerPk
  process.env.TG_ASSET_CODE ??= 'CSR'
  process.env.TG_JR_SK = kp.secret()
  const requesterKp = await buyGrant(onLog)
  onLog(`gate grant confirmed on ${process.env.TG_ASSET_CODE}`)

  const actor = {
    app: 'jr', iss: { name: 'jr', pk: kp.publicKey() }, sk: kp.secret(), WebSocket, wsArgs: [wsUrl],
  }
  const outbox = makeOutbox()
  outbox.push(JSON.stringify({ csr, network, email }))
  outbox.push('context.job.stdin.end()') // sentinel -- see daeh/lib/job.ts's indataEOD handling

  const gen = job(actor, { aud: 'csr', label: 'Csr', outbox, targetPk: ownerPk, matchTimeoutMs })
  let reply, jobError
  let step = await gen.next()
  while (!step.done) {
    const event = step.value
    if (event.type === 'message') reply = JSON.parse(event.payload.sub)
    else if (event.type === 'error') jobError = event.error
    step = await gen.next()
  }
  if (jobError) throw jobError;
  if (!reply) throw new Error('requestCsr(): no reply received');
  return { reply, requesterKp };
}

//async function pollJoinStatus (id, wsUrl, timeoutMs) {{{1
/** Polls tg/ws's own /catalog/join-status (see index.ts's joinStatusFetch)
 * until a human has actually acted on this request via csr-approve.mjs
 * -- there's no fixed SLA on a human looking at something, so this waits
 * forever by default (same "unset bound waits forever" convention this
 * codebase already uses for TG_GRANT_TIMEOUT_MS etc.), optionally bounded
 * by CSR_POLL_TIMEOUT_MS. Returns the full {status, cert?, message?}
 * entry once it's no longer 404 (nobody's acted yet). */
async function pollJoinStatus (id, wsUrl, timeoutMs) {
  const origin = new URL(wsUrl).origin
  const statusUrl = `${httpize(origin)}/catalog/join-status?id=${id}`
  const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity
  for (;;) {
    const res = await fetch(statusUrl)
    if (res.status === 200) return await res.json();
    if (res.status !== 404) throw new Error(`join-status: ${statusUrl} -> ${res.status}`);
    if (Date.now() >= deadline) throw new Error(`join-status: still pending after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 10_000))
  }
}

//export async function csrAndWait (...) {{{1
/** The whole flow past CSR generation: buy CSR, Match under 'csr', send
 * the CSR, then wait (pollJoinStatus()'s own no-fixed-SLA default) for a
 * human to act on it via csr-approve.mjs. On rejection, throws --
 * there's no refund of the XLM paid yet (cnj.md's own reimbursement-on-
 * rejection idea is real but not built here; this is a later, separate
 * piece). On approval, pays the CSR unit back (PoD, same as any other
 * Job) and stores the cert. Extracted from main() so compete.mjs can
 * reuse exactly this sequence for a first-time visitor with no cert yet,
 * instead of duplicating it. Returns the identity's own pk once its cert
 * is stored. */
export async function csrAndWait ({
  kp, ownerPk, wsUrl = 'wss://qa.ws.tg.kloudoftrust.org/ja',
  csr, network = 'testnet', email, name, matchTimeoutMs, pollTimeoutMs, onLog = () => {},
}) {
  const { reply, requesterKp } = await requestCsr({ kp, ownerPk, wsUrl, csr, network, email, matchTimeoutMs, onLog })
  onLog(`Agent reply: ${JSON.stringify(reply)}`)
  if (reply.status !== 'queued') throw new Error(`csr job didn't queue this: ${JSON.stringify(reply)}`);

  onLog(`queued as ${reply.id} -- waiting for a human to approve or reject...`)
  const status = await pollJoinStatus(reply.id, wsUrl, pollTimeoutMs)
  if (status.status === 'rejected') throw new Error(`csr rejected: ${status.message}`);

  const txId = await payBack(requesterKp)
  onLog(`PoD-TXID: ${txId}`)
  return await storeCert({ cert: status.cert, name });
}

async function main () { // {{{1
  const ownerPk = process.env.TG_ISSUER_PK
  if (!ownerPk) throw new Error('TG_ISSUER_PK must be set (the real Job Owners own Stellar public key)');
  const email = process.env.CSR_EMAIL
  if (!email) throw new Error('CSR_EMAIL must be set (where the issued cert should be sent)');
  const network = process.env.CSR_NETWORK ?? 'testnet'

  if (!process.env.TG_JR_SK) { // {{{2 see this file's own header: setting
    // this *before* requestCsr() runs is what unifies the CSR/OU identity
    // with the gate-trade identity, the same stable-keypair pattern sh's
    // E/P/F already use.
    const [sk] = (await generate_keypair()).split(' ')
    process.env.TG_JR_SK = sk
  } // }}}2
  const kp = Keypair.fromSecret(process.env.TG_JR_SK)
  const pk = kp.publicKey()

  const cn = process.env.CSR_CN ?? `csr-${randomUUID().slice(0, 8)}`
  const dir = certDirFor(pk)
  const { keyPath, csrPath, csr } = await generateCsr(pk, cn, dir)
  // Left for `cert` mode to read back later (see this file's own header) --
  // that's a separate, later process invocation with no other memory of
  // which network this request named, or of TG_JR_SK itself.
  await fs.writeFile(path.join(dir, 'sidecar.json'), JSON.stringify({ network, sk: process.env.TG_JR_SK }) + '\n')
  console.log(`[csr] generated CSR for ${pk} at ${csrPath}\n       (private key: ${keyPath})`)

  const storedPk = await csrAndWait({
    kp, ownerPk,
    wsUrl: process.env.TG_WS_URL,
    csr, network, email,
    name: process.env.CSR_NAME, // see this file's own header -- not
    // process.argv[2], which the CLI dispatcher (this file's own bottom)
    // uses to pick mainCert() over main() in the first place.
    matchTimeoutMs: Number(process.env.TG_MATCH_TIMEOUT_MS ?? 30_000),
    pollTimeoutMs: process.env.CSR_POLL_TIMEOUT_MS ? Number(process.env.CSR_POLL_TIMEOUT_MS) : undefined,
    onLog: line => console.log('[csr]', line),
  })
  console.log(`[csr] complete for ${storedPk}`)
}

//async function ouOf (certPath) {{{1
/** Reads back the Stellar PK a certificate's own OU field names -- same
 * convention generateCsr() set it to. This is how mainCert() learns which
 * identity a pasted certificate is for, straight from the artifact itself,
 * rather than requiring a TG_JR_SK (possibly long gone from the
 * environment by now) to say so a second time. */
async function ouOf (certPath) {
  const { stdout } = await execFileP('openssl', ['x509', '-noout', '-subject', '-in', certPath])
  const m = stdout.match(/OU\s*=\s*([^,/\n]+)/)
  if (!m) throw new Error('certificate has no OU field');
  return m[1].trim();
}

//export async function storeCert ({ cert, name }) {{{1
/** Recovers which identity `cert` is for from its own OU field, stores
 * it as cert.pem next to that identity's already-generated cert.key, the
 * same two files mtls.mjs's own readCert() expects. Validates the cert's
 * own public key matches the stored private key first (comparing RSA
 * moduli) -- the one thing that actually proves this is the certificate
 * *this* CSR asked for, not some other paste. Then promotes the identity
 * to a full, stable one: TG_JR_SK (read back from main()'s own sidecar,
 * not re-asked for) saved under ~/.config/.<network>/<pk>.sk, and an
 * extras.json naming it <name> (with a last-word alias if <name> has a
 * space -- see this file's own header on why). Extracted from mainCert()
 * so main()'s own auto-poll path can call this directly, with a cert
 * already in hand from join-status rather than from stdin -- mainCert()
 * itself is now just that stdin-reading wrapper, kept for the existing
 * manual, paste-it-yourself flow. Returns the identity's own pk. */
export async function storeCert ({ cert, name }) {
  if (!cert.includes('BEGIN CERTIFICATE')) throw new Error('no PEM certificate found');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'csr-cert-'))
  let pk
  try {
    const tmpCertPath = path.join(tmpDir, 'cert.pem')
    await fs.writeFile(tmpCertPath, cert)
    pk = await ouOf(tmpCertPath)

    const keyPath = path.join(certDirFor(pk), 'cert.key')
    const [{ stdout: certModulus }, { stdout: keyModulus }] = await Promise.all([
      execFileP('openssl', ['x509', '-noout', '-modulus', '-in', tmpCertPath]),
      execFileP('openssl', ['rsa', '-noout', '-modulus', '-in', keyPath]),
    ])
    if (certModulus.trim() !== keyModulus.trim()) {
      throw new Error(`certificate does not match the private key at ${keyPath} -- wrong paste?`);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }

  const dir = certDirFor(pk)
  const certPath = path.join(dir, 'cert.pem')
  await fs.writeFile(certPath, cert)
  console.log(`[csr] stored validated certificate for ${pk} at ${certPath}`)

  // Promotes this Requester to a full, stable identity -- see this file's {{{2
  // own header. sidecar.json is main()'s own, left alongside the CSR --
  // not validated against anything (CSR_NETWORK's own comment in main()
  // applies here too), just read back verbatim.
  const { network, sk } = JSON.parse(await fs.readFile(path.join(dir, 'sidecar.json'), 'utf-8'))
  const skDir = path.join(process.env.HOME, '.config', `.${network}`)
  await fs.mkdir(skDir, { recursive: true })
  const skPath = path.join(skDir, `${pk}.sk`)
  await fs.writeFile(skPath, `${sk}\n`)
  await fs.chmod(skPath, 0o600)
  console.log(`[csr] stored Stellar secret key for ${pk} (network: ${network}) at ${skPath}`)
  // }}}2

  if (name) { // {{{2 find-pk.mjs's own header explains the alias: a
    // multi-word name can never safely sit in a Make ${TEST} target
    // position (whitespace splits a rule's own target list), only a
    // space-free alias can -- same reasoning as Дід Alik/E.
    const words = name.trim().split(/\s+/)
    const extras = words.length > 1 ? { name, aliases: [words[words.length - 1]] } : { name }
    await fs.writeFile(path.join(dir, 'extras.json'), JSON.stringify(extras) + '\n')
    console.log(`[csr] stored extras.json for ${pk}:`, extras)
  } // }}}2

  // sidecar.json has done its one job (carrying TG_JR_SK/network from
  // main()'s own process to this one) and holds the raw secret key in
  // plaintext -- no reason to leave it sitting in a cert directory a
  // moment longer than it's needed, now that it's safely stored under
  // ~/.config/.<network>/<pk>.sk above.
  await fs.rm(path.join(dir, 'sidecar.json'), { force: true })
  return pk;
}

//async function mainCert (name) {{{1
/** `node csr.mjs <name>` -- the existing manual flow: reads a signed PEM
 * certificate pasted on stdin and hands it to storeCert(). Kept for
 * anyone still mid-flow this way; main()'s own auto-poll path no longer
 * needs a second, separate invocation at all. */
async function mainCert (name) {
  const cert = (await readStdin()).trim() + '\n'
  await storeCert({ cert, name })
}

if (import.meta.url === `file://${process.argv[1]}`) { // {{{1
  // One positional arg, <name> -- its mere presence is what selects cert
  // mode over the default CSR-request one (see this file's own header);
  // there's no separate literal 'cert' keyword to also check for.
  const run = process.argv[2] ? mainCert(process.argv[2]) : main()
  run.catch(e => {
    console.error('[csr] FAILED', e)
    process.exitCode = 1
  })
}
