#!/usr/bin/env node

// tg/sh/request-peer.mjs -- P's local process: serves a local pitch page {{{1
// for the phone's own browser, and on request, buys access to E's 'peer'
// job, waits to be matched and granted a jailed SSH account, retrieves
// tg/sh/stage/'s content out of it, confirms retrieval back to E, and
// verifies the content locally. Kept separate from tg/sh/p.mjs (BIT 1-3's
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
// Env:
//   SH_ISSUER_PK    -- required: E's own Stellar public key
//   SH_WS_URL       -- optional, defaults to the qa deploy
//   SH_LOCAL_PORT   -- optional, defaults to 8098 -- the local pitch page

import { execFile, spawn } from 'node:child_process' // {{{1
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { job } from '../../daeh/lib/job.ts'
import { buyGrant } from './gate-p.mjs'

const execFileP = promisify(execFile)
const PORT = Number(process.env.SH_LOCAL_PORT ?? 8098)

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

async function requestPeer () { // {{{1
  state = { status: 'running', log: [] }
  try {
    const { keyPath, pub } = await generateSshKeypair()
    log('buying access to the peer job...')
    const kp = await buyGrant(log)
    log('gate grant confirmed')

    const wsUrl = process.env.SH_WS_URL ?? 'wss://qa.ws.tg.kloudoftrust.org/sh'
    const actor = {
      app: pub, // the SSH public key, not the Stellar one -- see header
      iss: { name: 'P', pk: kp.publicKey() },
      sk: kp.secret(),
      WebSocket,
      wsArgs: [wsUrl],
    }
    const gen = job(actor, {
      aud: 'peer', label: 'Peer',
      matchTimeoutMs: Number(process.env.SH_MATCH_TIMEOUT_MS ?? 30_000),
    })
    let grantLine
    let step = await gen.next()
    while (!step.done) {
      const event = step.value
      if (event.type === 'open') log('connected, waiting to be matched with E...')
      else if (event.type === 'matched') log('matched -- waiting for the grant...')
      else if (event.type === 'message') { grantLine = event.payload.sub; log(`received: ${grantLine}`) }
      else if (event.type === 'error') log(`job error: ${event.error.message ?? event.error}`)
      step = await gen.next()
    }
    log(step.value.message)
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
      log(`(no direct route to E -- routing through ${jump})`)
      sshOpts.push('-J', jump)
    }

    log(`retrieving staged content from ${user}@${externalIP}:${sshPort}...`)
    const dest = path.join(path.dirname(keyPath), 'sh-received')
    await retrieveOverSsh(sshOpts, user, externalIP, dest)
    log(`retrieved into ${dest}`)

    await execFileP('ssh', [...sshOpts, `${user}@${externalIP}`, 'touch sh-stage/.retrieved'])
    log('confirmed retrieval to E')

    const readme = await fs.readFile(path.join(dest, 'README.md'), 'utf-8').catch(() => null)
    if (readme) {
      log(`BIT PASS -- retrieved content verified locally: ${readme.split('\n')[0]}`)
      state.status = 'done'
    } else {
      log('BIT FAIL -- retrieved content is missing the expected README.md')
      state.status = 'failed'
    }
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

const server = http.createServer((req, res) => { // {{{1
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PITCH_HTML)
  } else if (req.method === 'POST' && req.url === '/request') {
    if (state.status === 'running') {
      res.writeHead(409); res.end('already running'); return;
    }
    requestPeer()
    res.writeHead(202); res.end('started')
  } else if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(state))
  } else {
    res.writeHead(404); res.end('not found')
  }
})
server.listen(PORT, '127.0.0.1', () => console.log(`[sh:P] local page: http://localhost:${PORT}/`))
