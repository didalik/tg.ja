#!/usr/bin/env node

// tg/ja/public/jr/request-peer.mjs -- the Requester's local process for {{{1
// BIT 3's 'peer' job: serves a local pitch page for the phone's own
// browser, and on request, buys access to E's 'peer' job (tg/sh/gate.js,
// still the Agent's own private infrastructure -- only the Requester side
// moved here), waits to be matched and granted a jailed SSH account,
// retrieves the staged export of E's whole tg/sh directory out of it,
// confirms retrieval back to E, and verifies the content locally. Lives
// under tg/ja/public, not tg/sh, because tg/ja/public is meant to
// eventually become a public repo real end users run (ccddh.md), and
// they'll never have tg/sh
// available to them -- same reasoning jr/Makefile's own `peer` target is
// here rather than there. Kept separate from tg/sh/p.mjs (BIT 1-3's
// SSH-port-forwarding peering experiment) -- a different mechanism
// entirely, this one riding on the same daeh/lib/job.ts Stellar-gate +
// WS-match machinery ja/jr/db already use.
//
// Two keys, not one: the Stellar/MRT keypair (buyGrant, signs the WS
// handshake) proves payment and identity the way sh's design always
// intended -- but authenticating the SSH connection itself needs a real
// OpenSSH-format key, which a Stellar keypair isn't. A fresh ephemeral
// SSH keypair is generated per request; its *public* half rides in as the
// handshake's `sub` field (actor.app), the same repurposing db's own
// Requester already does -- grant.sh reads it back out via
// attachment.match?.sub for the account's authorized_keys.
//
// requestPeer() is exported so tg/ja/public/jr/bridge.mjs can call it
// directly (dqad.md's step 8), same "exported reusable function + thin
// CLI/server wrapper" shape buyinvite.mjs/csr.mjs/sell.mjs already have
// -- requestPeerBit() below (this file's own existing BIT path) is now
// just that thin wrapper.
//
// Env:
//   SH_ISSUER_PK    -- required: E's own Stellar public key
//   SH_ASSET_CODE   -- optional, defaults to 'PEER' -- must match
//                      toll_gate_peer's own (gate-p.mjs now requires
//                      this set; this file is the one caller dedicated
//                      enough to the peer job specifically to default it
//                      correctly rather than making every invocation set
//                      it by hand -- caught live: nothing on this
//                      Requester side ever set it at all before this,
//                      silently defaulting to gate-p.mjs's own old 'TGA'
//                      placeholder, which could never actually match
//                      the Agent's own 'PEER' sell offer).
//   SH_WS_URL       -- optional, defaults to the qa deploy
//   SH_LOCAL_PORT   -- optional, defaults to 8098 -- the local pitch page

import { execFile, spawn } from 'node:child_process' // {{{1
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { job } from '@amissine/daeh'
import { buyGrant } from './gate-p.mjs'

const execFileP = promisify(execFile)
const PORT = Number(process.env.SH_LOCAL_PORT ?? 8098)
process.env.SH_ASSET_CODE ??= 'PEER'

let state = { status: 'idle', log: [] }
const log = line => { console.log('[sh:P]', line); state.log.push(line) }

//async function retrieveOverSsh (sshOpts, user, externalIP, dest) {{{1
/** Pipes `ssh ... tar -cf - -C sh-stage .` into a local `tar -xf -`,
 * instead of `scp` -- scp needs its own binary present server-side to
 * handle the transfer, same requirement as `git clone`'s git-upload-pack,
 * and the jail skeleton only has busybox. Its `tar` applet is already
 * there (installed via `busybox --install -s .`), so this needs no
 * change to the jail at all, only here. `-C sh-stage .` on the remote
 * side archives sh-stage's *contents*, not sh-stage itself, so they land
 * directly in `dest` -- matching what `scp -r user@host:sh-stage dest`
 * would have done when dest doesn't already exist. */
async function retrieveOverSsh (sshOpts, user, externalIP, dest) {
  await fs.mkdir(dest, { recursive: true })
  return new Promise((resolve, reject) => {
    const ssh = spawn('ssh', [...sshOpts, `${user}@${externalIP}`, 'tar', '-cf', '-', '-C', 'sh-stage', '.'])
    const tar = spawn('tar', ['-xf', '-', '-C', dest])
    ssh.stdout.pipe(tar.stdin)
    let sshErr = '', sshCode, tarCode
    ssh.stderr.on('data', d => { sshErr += d })
    const finish = () => {
      if (sshCode == null || tarCode == null) return;
      sshCode === 0 && tarCode === 0
        ? resolve()
        : reject(new Error(`retrieve failed (ssh exit ${sshCode}, tar exit ${tarCode})${sshErr ? ': ' + sshErr.trim() : ''}`));
    }
    ssh.on('error', reject)
    tar.on('error', reject)
    ssh.on('close', code => { sshCode = code; finish() })
    tar.on('close', code => { tarCode = code; finish() })
  });
}

async function generateSshKeypair () { // {{{1
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sh-peer-'))
  const keyPath = path.join(dir, 'id_ed25519')
  await execFileP('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q'])
  const pub = (await fs.readFile(`${keyPath}.pub`, 'utf-8')).trim()
  return { keyPath, pub };
}

//export async function requestPeer ({ kp, issuerPk, wsUrl, matchTimeoutMs, destDir, onLog }) {{{1
/** The peer Job's own Requester-side flow, extracted so tg/ja/public/
 * jr/bridge.mjs can call it directly (dqad.md's step 8) instead of
 * running this file as a separate process a second way -- the server
 * below (main()) is now just a thin wrapper around this, behavior
 * otherwise unchanged for the existing `peer` BIT. Buys 1 unit of E's
 * own PEER asset, Matches under aud:'peer', retrieves the granted
 * jail's own staged tg/sh export over tar+ssh into destDir, confirms
 * retrieval back to E. Returns destDir once the retrieved content is
 * verified to actually be there (checked via its own README.md, same
 * check the BIT's own PASS/FAIL already made). */
export async function requestPeer ({
  kp, issuerPk = process.env.SH_ISSUER_PK, wsUrl = process.env.SH_WS_URL ?? 'wss://qa.ws.tg.kloudoftrust.org/jr',
  matchTimeoutMs = Number(process.env.SH_MATCH_TIMEOUT_MS ?? 30_000), destDir, onLog = () => {},
}) {
  if (!issuerPk) throw new Error('SH_ISSUER_PK must be set (Es own Stellar public key)');
  // gate-p.mjs's own buyGrant() reads SH_ISSUER_PK directly, not as a
  // param -- the issuerPk param above only fed targetPk below before
  // this line existed, so this call always used to fail unless a
  // caller had *also* separately exported SH_ISSUER_PK itself (true for
  // the BIT's own env-var-driven invocation, never true for a caller
  // passing issuerPk as an explicit param instead -- caught live, the
  // first time bridge.mjs actually exercised that path).
  process.env.SH_ISSUER_PK = issuerPk
  const { keyPath, pub } = await generateSshKeypair()
  onLog('buying access to the peer job...')
  // kp optional: buyGrant() reads SH_P_SK itself (and falls back to its
  // own fresh Keypair.random() when unset, same as the BIT's own call
  // below relies on) -- setting it here is just how a caller hands it a
  // specific identity, same "env var as the real param" shape every
  // other jr/*.mjs file already uses (e.g. buyinvite.mjs's own
  // TG_JR_SK). bridge.mjs passes the demo's own new JA identity through
  // this way, so this peer request (and the WS actor below) is
  // unmistakably *that* identity, not a throwaway one.
  if (kp) process.env.SH_P_SK = kp.secret()
  const grantedKp = await buyGrant(onLog)
  onLog('gate grant confirmed')

  // Every JR now connects via the same fixed /jr path (ccddh.md's
  // "retiring the registry" round) -- the old per-app smName (sh) is
  // moot since the room collapse already put every real WS connection
  // in one shared DO regardless of path.
  const actor = {
    app: pub, // the SSH public key, not the Stellar one -- see header
    iss: { name: 'P', pk: grantedKp.publicKey() },
    sk: grantedKp.secret(),
    WebSocket,
    wsArgs: [wsUrl],
  }
  const gen = job(actor, {
    aud: 'peer', label: 'Peer',
    // Which specific Agent's offer to match -- the one this Requester's
    // own gate trade just paid, not just any offer sharing this aud
    // (see daeh/lib/sdk.js's MRT.setTarget -- ccddh.md's Match-pairing
    // round).
    targetPk: issuerPk,
    matchTimeoutMs,
  })
  let grantLine
  let step = await gen.next()
  while (!step.done) {
    const event = step.value
    if (event.type === 'open') onLog('connected, waiting to be matched with E...')
    else if (event.type === 'matched') onLog('matched -- waiting for the grant...')
    else if (event.type === 'message') { grantLine = event.payload.sub; onLog(`received: ${grantLine}`) }
    else if (event.type === 'error') onLog(`job error: ${event.error.message ?? event.error}`)
    step = await gen.next()
  }
  onLog(step.value.message)
  if (!grantLine) throw new Error('no grant line received');

  const m = grantLine.match(/port=(\d+) externalIP=(\S+) user=(\S+)(?: jump=(\S+))?/)
  if (!m) throw new Error(`unrecognized grant line: ${grantLine}`);
  const [, sshPort, externalIP, user, jump] = m

  const knownHosts = `${keyPath}.known_hosts`
  const sshOpts = ['-i', keyPath, '-p', sshPort,
    '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${knownHosts}`]
  // jump (optional, grant.sh's own SH_AGENT_JUMP): E has no direct inbound
  // reachability of its own -- route through this "user@host" instead
  // (e.g. the VM's own hypervisor host, over its private network) --
  // same as any other SSH jump host, nothing E-specific about -J itself.
  if (jump) {
    onLog(`(no direct route to E -- routing through ${jump})`)
    sshOpts.push('-J', jump)
  }

  onLog(`retrieving staged content from ${user}@${externalIP}:${sshPort}...`)
  await retrieveOverSsh(sshOpts, user, externalIP, destDir)
  onLog(`retrieved into ${destDir}`)

  await execFileP('ssh', [...sshOpts, `${user}@${externalIP}`, 'touch sh-stage/.retrieved'])
  onLog('confirmed retrieval to E')

  const readme = await fs.readFile(path.join(destDir, 'README.md'), 'utf-8').catch(() => null)
  if (!readme) throw new Error('retrieved content is missing the expected README.md');
  onLog(`retrieved content verified locally: ${readme.split('\n')[0]}`)
  return destDir;
}

async function requestPeerBit () { // {{{1
  state = { status: 'running', log: [] }
  try {
    // No kp passed -- same as before this file's own requestPeer() was
    // extracted, this BIT doesn't care which identity, just that the
    // mechanism works; buyGrant() generates (and funds) its own fresh
    // one when SH_P_SK is unset.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sh-peer-'))
    const destDir = path.join(dir, 'sh-received')
    await requestPeer({ destDir, onLog: log })
    log(`BIT PASS -- ${destDir}`)
    state.status = 'done'
  } catch (err) {
    log(`BIT FAIL -- ${err.message}`)
    state.status = 'failed'
  }
}

const PITCH_HTML = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>sh -- for developers</title></head><body style="font-family: sans-serif; max-width: 640px; margin: 2em auto; padding: 0 1em">
<h2>sh: a peer, on demand</h2>
<p>This phone can become a full sh peer -- no account, no API key, just a small Stellar
payment to a peer who already trusts it. Tap below to request it.</p>
<button id="go" style="font-size: 1.2em; padding: 0.5em 1em">Request the peer job</button>
<pre id="log" style="background:#111;color:#0f0;padding:1em;white-space:pre-wrap;min-height:4em"></pre>
<script>
const btn = document.getElementById('go'), log = document.getElementById('log');
btn.onclick = async () => {
  btn.disabled = true;
  await fetch('/request', { method: 'POST' });
  const poll = setInterval(async () => {
    const s = await (await fetch('/status')).json();
    log.textContent = s.log.join('\\n');
    if (s.status !== 'running') { clearInterval(poll); btn.disabled = false; }
  }, 1000);
};
</script></body></html>`

if (import.meta.url === `file://${process.argv[1]}`) { // {{{1
  // Guards the server from starting at import time -- tg/ja/public/jr/
  // bridge.mjs imports this file's own requestPeer() without wanting a
  // second, redundant local server listening on PORT too (caught live:
  // before this guard existed, a plain `import { requestPeer } from
  // './request-peer.mjs'` already printed "local page: ..." as a side
  // effect, same bug main()'s own guard already exists elsewhere in
  // this codebase to prevent).
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(PITCH_HTML)
    } else if (req.method === 'POST' && req.url === '/request') {
      if (state.status === 'running') {
        res.writeHead(409); res.end('already running'); return;
      }
      requestPeerBit()
      res.writeHead(202); res.end('started')
    } else if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(state))
    } else {
      res.writeHead(404); res.end('not found')
    }
  })
  server.listen(PORT, '127.0.0.1', () => console.log(`[sh:P] local page: http://localhost:${PORT}/`))
}
