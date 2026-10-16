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
//   TG_ISSUER_PK   -- required for the default (CSR-request) mode: the
//                     target JA's own Stellar public key
//   TG_ASSET_CODE  -- optional, defaults to 'JOIN' (this Job's own fixed
//                     selector -- see requestJoin()'s own comment)
//   TG_PRICE, TG_JR_SK, TG_GRANT_TIMEOUT_MS -- see gate.js.
//                     Setting TG_JR_SK up front (rather than letting
//                     buyGrant() generate one) is what makes this script's
//                     own CSR/OU and the gate-trade identity the same
//                     stable keypair (round 20's MRT design, same as sh's
//                     E/P/F) instead of jr's own 'echo' BIT's two separate,
//                     disposable ones. Required for `cert` mode too (see
//                     below) -- it's what finds the matching private key
//                     the pasted-back certificate has to validate against.
//   TG_WS_URL      -- optional, defaults to the qa deploy
//   TG_MATCH_TIMEOUT_MS -- optional, defaults to 30000
//   JOIN_NETWORK   -- optional, defaults to 'testnet' -- Дід Alik's own
//                     bookkeeping only (round 34), not validated by any JA
//   JOIN_EMAIL     -- required: where the issued cert should be sent
//   JOIN_CN        -- optional, defaults to 'join-<shortid>' -- the CSR's
//                     own CN field
//   JOIN_CERT_DIR  -- optional, defaults to this identity's own
//                     ~/.config/.cloudflare-job-fair/<pk>/ (same PK-keyed
//                     layout as E/P/F's own certs, ccddh.md's "Keys and
//                     Certificates local storage, Redefined") -- where the
//                     generated keypair/CSR are written, and where `cert`
//                     mode (below) later looks for that same keypair once
//                     the signed certificate comes back.
//
// Usage:
//   node join.mjs        -- default mode: generate a CSR, request `join`,
//                            print the Agent's reply (BIT 2's own queuing
//                            test, and "join calling join" forwarding).
//   node join.mjs cert    -- completes BIT 2 once a signed certificate
//                            comes back from whoever owns `join` (manually,
//                            e.g. pasted after Cloudflare's CA issues it):
//                            reads a PEM certificate from stdin, confirms
//                            its public key matches TG_JR_SK's own already-
//                            generated private key (proof this is really
//                            the cert for *this* CSR, not a mismatched
//                            paste), and stores it as cert.pem alongside
//                            cert.key -- the same two files mtls.mjs's own
//                            readCert() already expects, so this identity
//                            is immediately usable for real mTLS with no
//                            further wiring. Also saves TG_JR_SK itself
//                            under ~/.config/.<network>/<pk>.sk (the same
//                            convention every other stable identity --
//                            Дід Alik, JA2, ...-- already uses), so this
//                            Requester becomes a fully-fledged, find-pk.mjs-
//                            resolvable-by-PK identity the moment its cert
//                            lands, not just a disposable one-shot CSR.
//                            <network> is whatever this CSR's own original
//                            request carried (JOIN_NETWORK, below) -- read
//                            back from a sidecar main() leaves next to the
//                            CSR, since cert mode runs as its own separate,
//                            later invocation with no other memory of it.

import { execFile } from 'node:child_process' // {{{1
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { Keypair } from '@stellar/stellar-sdk'
import WebSocket from 'ws'
import { generate_keypair } from '../../../../daeh/lib/sdk.js'
import { job } from '../../../../daeh/lib/job.ts'
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

//function certDirFor (pk) {{{1
/** Where this identity's TLS keypair/CSR/cert live -- PK-keyed, same
 * layout mtls.mjs's own CERT_BASE uses, so a cert stored here needs no
 * further wiring to become usable. Shared by main() (CSR generation) and
 * mainCert() (storing the signed cert later) so both land in the exact
 * same directory for the same identity. */
function certDirFor (pk) {
  return process.env.JOIN_CERT_DIR ?? `${process.env.HOME}/.config/.cloudflare-job-fair/${pk}`;
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

//async function generateCsr (pk, cn, dir) {{{1
/** Generates a fresh TLS keypair + CSR locally -- OU set to the
 * Requester's own Stellar PK, the same convention E/P/F's own certs use
 * (see ccddh.md's Pi4b (F) runbook). The private key never leaves `dir`. */
async function generateCsr (pk, cn, dir) {
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
  // One try/finally around the whole flow, not just buyGrant() -- payBack()
  // below reads these same env vars, and needs them still set when it runs,
  // not restored to whatever they were before this call.
  try {
    const kp = await buyGrant(onLog)
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

    // Proof of Delivery, redefined (ccddh.md): pay the gate asset back to
    // whoever we bought it from, now that the Job is done -- same
    // unilateral payment jr's own echo BIT uses, works the same way
    // whether issuerPk is the real Owner or a reseller.
    const txId = await payBack(kp)
    onLog(`PoD-TXID: ${txId}`)
    return reply;
  } finally {
    restoreEnv(prev)
  }
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
  const dir = certDirFor(pk)
  const { keyPath, csrPath, csr } = await generateCsr(pk, cn, dir)
  // Left for `cert` mode to read back later (see this file's own header) --
  // that's a separate, later process invocation with no other way to learn
  // which network this particular CSR's own request named.
  await fs.writeFile(path.join(dir, 'network'), `${network}\n`)
  console.log(`[join] generated CSR for ${pk} at ${csrPath}\n       (private key: ${keyPath})`)

  const reply = await requestJoin({
    issuerPk,
    wsUrl: process.env.TG_WS_URL,
    csr, network, email,
    matchTimeoutMs: Number(process.env.TG_MATCH_TIMEOUT_MS ?? 30_000),
    onLog: line => console.log('[join] gate:', line),
  })
  console.log('[join] Agent reply:', reply)
}

//async function mainCert () {{{1
/** `node join.mjs cert` -- completes BIT 2 (see this file's own header):
 * reads a signed PEM certificate from stdin and stores it as cert.pem
 * next to this identity's already-generated cert.key, the same two files
 * mtls.mjs's own readCert() expects -- no further wiring needed once this
 * returns. Validates the cert's own public key matches the stored private
 * key first (comparing RSA moduli) -- the one thing that actually proves
 * this is the certificate *this* CSR asked for, not some other paste. */
async function mainCert () {
  if (!process.env.TG_JR_SK) throw new Error('TG_JR_SK must be set -- which identity is this certificate for?');
  const pk = Keypair.fromSecret(process.env.TG_JR_SK).publicKey()
  const dir = certDirFor(pk)
  const keyPath = path.join(dir, 'cert.key')
  const certPath = path.join(dir, 'cert.pem')

  const cert = (await readStdin()).trim() + '\n'
  if (!cert.includes('BEGIN CERTIFICATE')) throw new Error('no PEM certificate found on stdin');

  const tmpDir = await fs.mkdtemp(path.join('/tmp', 'join-cert-'))
  try {
    const tmpCertPath = path.join(tmpDir, 'cert.pem')
    await fs.writeFile(tmpCertPath, cert)
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

  await fs.writeFile(certPath, cert)
  console.log(`[join] stored validated certificate for ${pk} at ${certPath}`)

  // Promotes this Requester to a full, stable identity -- see this file's {{{2
  // own header: not validated against anything (JOIN_NETWORK's own
  // comment in main() applies here too), just read back verbatim from the
  // sidecar main() left alongside the CSR. Falls back to 'testnet' if
  // that sidecar is missing (a CSR generated before this existed).
  const network = await fs.readFile(path.join(dir, 'network'), 'utf-8').then(s => s.trim()).catch(() => 'testnet')
  const skDir = path.join(process.env.HOME, '.config', `.${network}`)
  await fs.mkdir(skDir, { recursive: true })
  const skPath = path.join(skDir, `${pk}.sk`)
  await fs.writeFile(skPath, `${process.env.TG_JR_SK}\n`)
  await fs.chmod(skPath, 0o600)
  console.log(`[join] stored Stellar secret key for ${pk} (network: ${network}) at ${skPath}`)
  // }}}2
}

if (import.meta.url === `file://${process.argv[1]}`) { // {{{1
  const run = process.argv[2] === 'cert' ? mainCert() : main()
  run.catch(e => {
    console.error('[join] FAILED', e)
    process.exitCode = 1
  })
}
