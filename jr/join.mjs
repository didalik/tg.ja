#!/usr/bin/env node

// tg/ja/public/jr/join.mjs -- the join Use Case's Requester side {{{1
// (ccddh.md's "The join Use Case and its BITs", round 34's CSR fix, and
// the later RTOJ-redesign round that replaced the gate entirely):
// generates the Requester's own Stellar keypair and TLS CSR locally (the
// private key never leaves this process), then -- instead of buying a
// separate 'JOIN' asset with XLM -- does an RTOJ trade (daeh/rtoj.mjs's
// own buyRtoj() -- promoted there from a k2-parent-repo-only tg/ja/rtoj.mjs,
// since this submodule needs to resolve it standing alone, same reason
// stellar.mjs was promoted into daeh, round 6) against the real asset of
// whichever Job it actually wants
// to be allowed to offer (TG_ASSET_CODE, e.g. ECHO). That trade is the
// only PoP this flow gets; once it fills, this applicant (and only this
// applicant, until it's used) can Match under aud: 'join' at all (see
// join-agent.mjs's own allowlist check) and send
// {kind, csr, network, email}.
//
// No more requestJoin()-by-a-forwarder ("join calling join", round 34) --
// only the real Job Owner's own join-server.mjs ever offers aud: 'join'
// now, so this is only ever called by the actual applicant.
//
// Env (direct CLI use):
//   TG_ISSUER_PK   -- required: the real Job Owner's own Stellar public key
//   TG_ASSET_CODE  -- required: which Job's real asset to RTOJ against
//                     (e.g. ECHO) -- no default any more, since 'JOIN'
//                     doesn't exist as its own asset to fall back to.
//   TG_JR_SK, TG_GRANT_TIMEOUT_MS -- see daeh/rtoj.mjs. Setting TG_JR_SK up
//                     front (rather than letting buyRtoj() generate one)
//                     is what makes this script's own CSR/OU and the
//                     RTOJ-trade identity the same stable keypair (round
//                     20's MRT design, same as sh's E/P/F). Only needed
//                     for the default mode -- `cert` mode (below) needs
//                     nothing from the environment at all, since it reads
//                     TG_JR_SK back from its own sidecar instead (a
//                     separate, later process invocation).
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
//   node join.mjs         -- default mode: generate a CSR, RTOJ against
//                                the target Job's real asset, request
//                                `join` once that trade fills, print the
//                                Agent's reply. Leaves a sidecar.json next to
//                                the CSR (network + TG_JR_SK itself) for
//                                the other mode to pick up later -- that
//                                mode deletes it once it's done with it
//                                (see mainCert()'s own comment), so its
//                                presence also doubles as "cert not
//                                completed yet" for this identity.
//   node join.mjs <name>  -- completes BIT 2 once a signed certificate
//                                comes back from whoever owns `join`
//                                (manually, e.g. pasted after Cloudflare's
//                                CA issues it): reads a PEM certificate
//                                from stdin, recovers which identity it's
//                                for from the certificate's own OU field
//                                (the same Stellar PK the CSR's OU already
//                                named -- no env var needed to say so
//                                again), confirms its public key matches
//                                that identity's already-generated private
//                                key (proof this is really the cert *this*
//                                CSR asked for, not a mismatched paste), and
//                                stores it as cert.pem alongside cert.key --
//                                the same two files mtls.mjs's own
//                                readCert() already expects, so this
//                                identity is immediately usable for real
//                                mTLS with no further wiring. Also reads
//                                TG_JR_SK back from the sidecar main() left
//                                behind and saves it under
//                                ~/.config/.<network>/<pk>.sk (the same
//                                convention every other stable identity --
//                                Дід Alik, JA2, ... -- already uses), and
//                                writes an extras.json naming this identity
//                                <name> (typically ${WHOAMI}) -- together,
//                                this Requester becomes a fully-fledged,
//                                find-pk.mjs-resolvable identity the moment
//                                its cert lands, not just a disposable
//                                one-shot CSR. <name> containing a space
//                                (e.g. "Дід Alik") gets its last word saved
//                                as an alias -- find-pk.mjs's own header
//                                explains why: a multi-word name can never
//                                safely sit in a Make ${TEST} target
//                                position, only an alias can.

import { execFile } from 'node:child_process' // {{{1
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { Keypair } from '@stellar/stellar-sdk'
import WebSocket from 'ws'
import { generate_keypair } from 'daeh/sdk.js'
import { job } from 'daeh'
import { buyRtoj } from 'daeh/rtoj.mjs'

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

//export async function requestJoin (...) {{{1
/** The join Use Case's Requester-side flow, redesigned (ccddh.md's
 * RTOJ-redesign round): does an RTOJ trade (buyRtoj(), daeh/rtoj.mjs) against
 * ownerPk's real `assetCode` asset -- the only PoP this flow gets -- then
 * Matches under aud: 'join' (only this applicant, now that its trade
 * just filled, can) and sends {kind, csr, network, email}, returning the
 * Agent's parsed JSON reply. Deliberately no payBack() call here: there's
 * no PoD unless the Requester pays back voluntarily (ccddh.md) -- nothing
 * was necessarily delivered if the Owner rejects in the Relay phase, so
 * this doesn't assume delivery happened the way echo's own BIT can. */
export async function requestJoin ({
  kp, ownerPk, assetCode, wsUrl = 'wss://qa.ws.tg.kloudoftrust.org/ja',
  kind = 'cert', csr, network, email, matchTimeoutMs, onLog = () => {},
}) {
  await buyRtoj({ kp, ownerPk, assetCode, onLog })
  onLog(`RTOJ trade filled on ${assetCode} -- allowlisted for aud:'join'`)

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
  return reply;
}

async function main () { // {{{1
  const ownerPk = process.env.TG_ISSUER_PK
  if (!ownerPk) throw new Error('TG_ISSUER_PK must be set (the real Job Owners own Stellar public key)');
  const assetCode = process.env.TG_ASSET_CODE
  if (!assetCode) throw new Error('TG_ASSET_CODE must be set (which Job asset to RTOJ against, e.g. ECHO)');
  const email = process.env.JOIN_EMAIL
  if (!email) throw new Error('JOIN_EMAIL must be set (where the issued cert should be sent)');
  const network = process.env.JOIN_NETWORK ?? 'testnet'

  if (!process.env.TG_JR_SK) { // {{{2 see this file's own header: setting
    // this *before* buyRtoj() runs is what unifies the CSR/OU identity
    // with the RTOJ-trade identity, the same stable-keypair pattern sh's
    // E/P/F already use.
    const [sk] = (await generate_keypair()).split(' ')
    process.env.TG_JR_SK = sk
  } // }}}2
  const kp = Keypair.fromSecret(process.env.TG_JR_SK)
  const pk = kp.publicKey()

  const cn = process.env.JOIN_CN ?? `join-${randomUUID().slice(0, 8)}`
  const dir = certDirFor(pk)
  const { keyPath, csrPath, csr } = await generateCsr(pk, cn, dir)
  // Left for `cert` mode to read back later (see this file's own header) --
  // that's a separate, later process invocation with no other memory of
  // which network this request named, or of TG_JR_SK itself.
  await fs.writeFile(path.join(dir, 'sidecar.json'), JSON.stringify({ network, sk: process.env.TG_JR_SK }) + '\n')
  console.log(`[join] generated CSR for ${pk} at ${csrPath}\n       (private key: ${keyPath})`)

  const reply = await requestJoin({
    kp, ownerPk, assetCode,
    wsUrl: process.env.TG_WS_URL,
    csr, network, email,
    matchTimeoutMs: Number(process.env.TG_MATCH_TIMEOUT_MS ?? 30_000),
    onLog: line => console.log('[join] gate:', line),
  })
  console.log('[join] Agent reply:', reply)
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

//async function mainCert (name) {{{1
/** `node join.mjs cert <name>` -- completes BIT 2 (see this file's own
 * header): reads a signed PEM certificate from stdin, recovers which
 * identity it's for from the cert's own OU field, and stores it as
 * cert.pem next to that identity's already-generated cert.key, the same
 * two files mtls.mjs's own readCert() expects. Validates the cert's own
 * public key matches the stored private key first (comparing RSA moduli)
 * -- the one thing that actually proves this is the certificate *this*
 * CSR asked for, not some other paste. Then promotes the identity to a
 * full, stable one: TG_JR_SK (read back from main()'s own sidecar, not
 * re-asked for) saved under ~/.config/.<network>/<pk>.sk, and an
 * extras.json naming it <name> (with a last-word alias if <name> has a
 * space -- see this file's own header on why). */
async function mainCert (name) {
  const cert = (await readStdin()).trim() + '\n'
  if (!cert.includes('BEGIN CERTIFICATE')) throw new Error('no PEM certificate found on stdin');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'join-cert-'))
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
  console.log(`[join] stored validated certificate for ${pk} at ${certPath}`)

  // Promotes this Requester to a full, stable identity -- see this file's {{{2
  // own header. sidecar.json is main()'s own, left alongside the CSR --
  // not validated against anything (JOIN_NETWORK's own comment in main()
  // applies here too), just read back verbatim.
  const { network, sk } = JSON.parse(await fs.readFile(path.join(dir, 'sidecar.json'), 'utf-8'))
  const skDir = path.join(process.env.HOME, '.config', `.${network}`)
  await fs.mkdir(skDir, { recursive: true })
  const skPath = path.join(skDir, `${pk}.sk`)
  await fs.writeFile(skPath, `${sk}\n`)
  await fs.chmod(skPath, 0o600)
  console.log(`[join] stored Stellar secret key for ${pk} (network: ${network}) at ${skPath}`)
  // }}}2

  if (name) { // {{{2 find-pk.mjs's own header explains the alias: a
    // multi-word name can never safely sit in a Make ${TEST} target
    // position (whitespace splits a rule's own target list), only a
    // space-free alias can -- same reasoning as Дід Alik/E.
    const words = name.trim().split(/\s+/)
    const extras = words.length > 1 ? { name, aliases: [words[words.length - 1]] } : { name }
    await fs.writeFile(path.join(dir, 'extras.json'), JSON.stringify(extras) + '\n')
    console.log(`[join] stored extras.json for ${pk}:`, extras)
  } // }}}2

  // sidecar.json has done its one job (carrying TG_JR_SK/network from
  // main()'s own process to this one) and holds the raw secret key in
  // plaintext -- no reason to leave it sitting in a cert directory a
  // moment longer than it's needed, now that it's safely stored under
  // ~/.config/.<network>/<pk>.sk above.
  await fs.rm(path.join(dir, 'sidecar.json'), { force: true })
}

if (import.meta.url === `file://${process.argv[1]}`) { // {{{1
  // One positional arg, <name> -- its mere presence is what selects cert
  // mode over the default CSR-request one (see this file's own header);
  // there's no separate literal 'cert' keyword to also check for.
  const run = process.argv[2] ? mainCert(process.argv[2]) : main()
  run.catch(e => {
    console.error('[join] FAILED', e)
    process.exitCode = 1
  })
}
