import { put, reset, } from './lib/util.mjs' // {{{1
import { generate_keypair, } from 'daeh/sdk.js'
import { job, } from 'daeh'
import { httpize, wsize, } from 'daeh/util.mjs'
import { buyGrant, payBack, } from './jr/gate.js'

// gate.js/stellar.mjs read process.env.* (TG_ISSUER_PK, TG_ASSET_CODE, {{{1
// TG_PRICE, TG_GRANT_TIMEOUT_MS, TG_STELLAR_NETWORK, ...) -- same trick
// hx/public/tm.mjs uses to keep those reads from throwing in the browser:
// each one just comes back undefined and falls through to its own ??
// default, exactly as it would under Node.
window.process = { env: {} }

// tg/ja/public/lib/util.mjs's put() is the simpler copy (no scroll) of {{{1
// hx/public/lib/util.mjs's original -- keeping the animated-scroll-to-
// bottom behavior local to this page rather than changing the shared
// helper, since nothing else using it needs it.
const out = m => {
  put(`<div>${m}</div>`)
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
}

reset({ content: document.getElementById('content1') }) // {{{1

//function makeOutbox () {{{1
/** A one-shot outbox: queue up the lines to send ahead of time, pumpOutbox
 * (inside daeh's job()) pulls them one at a time once matched. Blocks
 * forever once the queue is drained -- fine here, there's nothing more to
 * say after the sentinel. Same as tg/ja/public/jr/run.js's own. */
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
  // The whole point: this page's own URL *is* TG_WS_URL, ws-ized -- no env
  // var, no config file. Served at tg/ja's own /ja (see ../src/index.js),
  // whose wsurHandler already proxies a WS-upgrade at this same path
  // through to tg/ws -- so connecting here reaches the real Durable
  // Object exactly the way Node jr's TG_WS_URL does, just same-origin
  // instead of direct.
  const wsUrl = wsize(location.href)
  //out(`wsUrl: ${wsUrl}`)

  const [sk, pk] = (await generate_keypair()).split(' ')
  const actor = {
    app: 'jr',
    iss: { name: 'jr', pk },
    sk,
    WebSocket,
    wsArgs: [wsUrl],
  }

  // httpize(wsUrl) + '/registry' reaches tg/ws's own /<smName>/registry --
  // directly for Node jr (TG_WS_URL points straight at tg/ws), and here
  // via tg/ja's own matching /<smName>/registry proxy route (see
  // ../src/index.js/util.mjs's registryHandler), since a plain fetch()
  // (unlike a WebSocket) is subject to CORS, and this keeps every request
  // this page makes on its own origin.
  const registryUrl = `${httpize(wsUrl)}/registry`
  const res = await fetch(registryUrl)
  if (res.ok) {
    const entry = await res.json()
    window.process.env.TG_ISSUER_PK = entry.issuerPk
    if (entry.assetCode) window.process.env.TG_ASSET_CODE = entry.assetCode
    if (entry.price) window.process.env.TG_PRICE = entry.price
    out(`registry: found ${JSON.stringify(entry)}`)
  } else {
    out(`registry: no entry (${registryUrl} -&gt; ${res.status})`)
  }

  let requesterKp
  if (window.process.env.TG_ISSUER_PK) {
    requesterKp = await buyGrant(line => out(`gate: ${line}`))
    out('gate grant confirmed')
  } else {
    out('TG_ISSUER_PK not set (via registry) -- gating skipped (dev/test only)')
  }

  const outbox = makeOutbox()
  outbox.push('hello from jr')
  outbox.push('context.job.stdin.end()') // sentinel -- see daeh/lib/job.ts's indataEOD handling

  const gen = job(actor, {
    aud: 'echo', label: 'Echo', outbox,
    matchTimeoutMs: 30_000,
  })
  let step = await gen.next()
  while (!step.done) {
    const event = step.value
    if (event.type === 'open') {
      out('Connected, waiting to be matched with an Agent...')
    } else if (event.type === 'matched') {
      out('Matched -- sending the echo request...')
    } else if (event.type === 'output') {
      out(`sent: ${event.line}`)
    } else if (event.type === 'message') {
      out(`echo reply: ${event.payload.sub}`)
    } else if (event.type === 'error') {
      out(`job error: ${event.error}`)
    }
    step = await gen.next()
  }
  out(step.value.message)

  // Proof of Delivery, redefined (ccddh.md): pay the gate asset back to
  // the Agent now that the Job is done, unilaterally -- no XDR from the
  // Agent needed any more, same as Node jr's own run.js.
  if (requesterKp) {
    const txId = await payBack(requesterKp)
    out(`PoD-TXID: ${txId}`) // bare, meant to be parsed later
  }
}

main().catch(e => { // {{{1
  console.error('FAILED', e)
  out(`FAILED: ${e.message}`)
})
