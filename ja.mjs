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
/** Live, push-based outbox -- same shape jr/chat.mjs's own uses (push()
 * resolves an already-waiting receive() immediately if there is one,
 * otherwise queues), not a pre-queued one-shot version. Lets the chat
 * loop below feed lines in as they're typed, one job() session at a
 * time, instead of sending a single hardcoded line and ending
 * immediately (ccddh.md's "both cards run plain ECHO" round -- the
 * connection target was always right, but a one-shot "hello from jr"
 * never gave Tosh's own LLM-backed echo a real conversation to show
 * any difference in). */
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

//async function waitForType (gen, type) {{{1
/** Drains gen until it yields an event of `type`, surfacing any 'error'
 * event along the way by throwing it instead. Used once, right after
 * matching, to let the Agent's own job actually spawn before the chat
 * form starts accepting input. Same as jr/chat.mjs's own. */
async function waitForType (gen, type) {
  let step = await gen.next()
  while (!step.done) {
    const event = step.value
    if (event.type === type) return event;
    if (event.type === 'error') throw event.error;
    step = await gen.next()
  }
  throw new Error(`ja: connection closed before a '${type}' event`);
}

//async function nextMessage (gen) {{{1
/** Drains gen until the next 'message' event (the Agent's own reply) --
 * skipping over 'output' (just confirms what *we* sent) along the way.
 * Returns null once the generator's done (the Agent closed the
 * connection), instead of throwing, since that's an ordinary way for a
 * chat to end, not a failure. Same as jr/chat.mjs's own. */
async function nextMessage (gen) {
  let step = await gen.next()
  while (!step.done) {
    const event = step.value
    if (event.type === 'message') return event.payload.sub;
    if (event.type === 'error') throw event.error;
    step = await gen.next()
  }
  return null;
}

async function main () { // {{{1
  // The whole point: this page's own URL *is* TG_WS_URL, ws-ized -- no env
  // var, no config file. Served at tg/ja's own /ja (see ../src/index.js),
  // whose wsurHandler already proxies a WS-upgrade at this same path
  // through to tg/ws -- so connecting here reaches the real Durable
  // Object exactly the way Node jr's TG_WS_URL does, just same-origin
  // instead of direct.
  // Fallback connect target if discovery below finds nothing -- kept, not
  // discarded, since catalog discovery only overwrites it on an actual hit.
  let wsUrl = wsize(location.href)
  //out(`wsUrl: ${wsUrl}`)

  const [sk, pk] = (await generate_keypair()).split(' ')
  window.process.env.TG_ASSET_CODE ??= 'ECHO' // must precede the catalog query below -- it's the lookup key
  const origin = new URL(wsUrl).origin // ws(s): is a WHATWG "special" scheme -- .origin drops the path, keeps scheme+host+port

  // A visitor who picked a *specific seller* on the intro page's own
  // catalog list arrives here with ?issuerPk=...&smName=... already in
  // the URL -- a real, deliberate pin, used directly, no discovery at
  // all (ccddh.md's discovery-ambiguity round). A visitor who picked a
  // *Job* instead (ccddh.md's reselling round -- intro.mjs's own
  // renderCatalog groups genuinely-fungible resale entries into one
  // card) arrives with ?realIssuerPk=...&assetCode=... instead, no
  // issuerPk -- resolved below to whichever group member is actually
  // cheapest right now, same DEX-driven pick blind auto-discovery
  // already uses, just scoped to real substitutes for what was shown
  // rather than the whole assetCode (which could cross into a different
  // experience entirely, e.g. Tosh's own LLM-backed chat). Falls through
  // to blind, whole-assetCode auto-discovery only when *neither* is set
  // -- a direct, bookmarked /ja link still works unchanged.
  const picked = new URLSearchParams(location.search)
  let aud = 'echo' // {{{2 overwritten below on a hit either way -- 'echo' is only the
  // fallback for entries that never set TG_AUD (every echo one so far).
  if (picked.get('issuerPk') && picked.get('smName')) {
    window.process.env.TG_ISSUER_PK = picked.get('issuerPk')
    if (picked.get('assetCode')) window.process.env.TG_ASSET_CODE = picked.get('assetCode')
    // A direct pin to a reseller's own entry still needs gate.js to know
    // the *real* asset to trust/buy is someone else's, not this seller's
    // own look-alike -- same gap as the discovery branch below, fixed
    // the same way (caught live: JA3's own real resale, found correctly
    // via realIssuerPk-scoped discovery, still bought the wrong,
    // JA3-self-issued "ECHO" because nothing ever set this).
    if (picked.get('realIssuerPk')) window.process.env.TG_ASSET_ISSUER_PK = picked.get('realIssuerPk')
    if (picked.get('aud')) aud = picked.get('aud')
    wsUrl = `${origin}/${picked.get('smName')}`
    out(`picked: ${picked.get('assetCode') ?? window.process.env.TG_ASSET_CODE} from ${picked.get('issuerPk')}`)
    if (picked.get('description')) out(picked.get('description'))
  } else {
    if (picked.get('assetCode')) window.process.env.TG_ASSET_CODE = picked.get('assetCode')
    // httpize(origin) + '/catalog/registry' reaches tg/ws's own one shared
    // job catalog -- directly for Node jr (TG_WS_URL points straight at
    // tg/ws), and here via tg/ja's own matching /catalog/registry proxy
    // route (see ../src/index.js/util.mjs's registryHandler), since a plain
    // fetch() (unlike a WebSocket) is subject to CORS, and this keeps every
    // request this page makes on its own origin.
    const registryUrl = `${httpize(origin)}/catalog/registry?assetCode=${window.process.env.TG_ASSET_CODE}`
    const res = await fetch(registryUrl)
    if (res.ok) {
      let entries = await res.json() // always an array now (possibly empty), never 404
      const realIssuerPk = picked.get('realIssuerPk')
      if (realIssuerPk) entries = entries.filter(e => (e.realIssuerPk ?? e.issuerPk) === realIssuerPk);
      if (entries.length > 0) {
        const entry = entries[0] // server-sorted cheapest-priced first, scoped above if realIssuerPk was given
        window.process.env.TG_ISSUER_PK = entry.issuerPk
        window.process.env.TG_ASSET_CODE = entry.assetCode
        // The real asset to trust/buy, when this entry is a reseller's
        // own (gate.js's own mirror-image env var) -- without this,
        // gate.js falls back to trusting/buying entry.issuerPk's own
        // self-issued look-alike instead of the real thing it actually
        // sells (caught live: JA3's own real resale, found correctly via
        // discovery, still never filled -- wrong asset entirely).
        if (entry.realIssuerPk) window.process.env.TG_ASSET_ISSUER_PK = entry.realIssuerPk
        if (entry.price) window.process.env.TG_PRICE = entry.price
        if (entry.aud) aud = entry.aud
        wsUrl = `${origin}/${entry.smName}` // the catalog, not this page's own serving smName, says where to connect
        out(`registry: found ${JSON.stringify(entry)}`)
      } else {
        out(`registry: no entry (${registryUrl}${realIssuerPk ? ` filtered to realIssuerPk=${realIssuerPk}` : ''})`)
      }
    } else {
      out(`registry: lookup failed (${registryUrl} -> ${res.status})`)
    }
  }

  const actor = {
    app: 'jr',
    iss: { name: 'jr', pk },
    sk,
    WebSocket,
    wsArgs: [wsUrl],
  }

  let requesterKp
  if (window.process.env.TG_ISSUER_PK) {
    requesterKp = await buyGrant(line => out(`gate: ${line}`))
    out('gate grant confirmed')
  } else {
    out('TG_ISSUER_PK not set (via registry) -- gating skipped (dev/test only)')
  }

  const outbox = makeOutbox()
  const gen = job(actor, {
    aud, label: aud === 'calc' ? 'Calc' : 'Echo', outbox,
    matchTimeoutMs: 30_000,
  })
  await waitForType(gen, 'matched')
  out(aud === 'calc'
    ? "Matched -- type an arithmetic expression below and hit Send, e.g. '2 + 3 * 4'. One gate trade pays for the whole session."
    : 'Matched -- type a message below and hit Send. One gate trade pays for the whole session.')

  // Disabled by default in the markup (nothing to type into until
  // matched) -- enable now that there's actually a session to chat in.
  document.getElementById('chatInput').disabled = false
  document.getElementById('sendBtn').disabled = false
  document.getElementById('endBtn').disabled = false

  // Interactive, multi-turn chat -- form submit replaces the old single
  // hardcoded outbox.push('hello from jr'), the "End Session" button
  // replaces Node chat.mjs's own Ctrl-D. Both the Agent's own job (if
  // it's Tosh's) and the relay already support more than one message
  // per Match (daeh/lib/job.ts's own indataEOD handling) -- this page
  // just never drove it that way before. {{{1
  const form = document.getElementById('chatForm')
  const input = document.getElementById('chatInput')
  const sendBtn = document.getElementById('sendBtn')
  const endBtn = document.getElementById('endBtn')
  let ended = false

  async function endSession () {
    if (ended) return;
    ended = true
    input.disabled = true; sendBtn.disabled = true; endBtn.disabled = true
    outbox.push('context.job.stdin.end()')
    let step = await gen.next()
    while (!step.done) step = await gen.next(); // drain to the final close
    if (requesterKp) {
      const txId = await payBack(requesterKp)
      out(`PoD-TXID: ${txId}`) // bare, meant to be parsed later
    }
    if (step.value) out(step.value.message)
  }

  form.addEventListener('submit', async e => {
    e.preventDefault()
    if (ended) return;
    const line = input.value.trim()
    if (!line) return;
    input.value = ''
    input.disabled = true; sendBtn.disabled = true
    out(`&gt; ${line}`)
    outbox.push(line + '\n') // +'\n': the Agent's own job (readline-based) needs one to see a complete line -- see jr/chat.mjs's own note on this
    try {
      const reply = await nextMessage(gen)
      if (reply === null) { out('connection closed'); ended = true; return; }
      out(reply)
    } catch (err) {
      out(`error: ${err.message ?? err}`)
    }
    if (!ended) { input.disabled = false; sendBtn.disabled = false; input.focus() }
  })

  endBtn.addEventListener('click', () => endSession().catch(e => out(`FAILED to end session: ${e?.message ?? String(e)}`)))
}

main().catch(e => { // {{{1
  console.error('FAILED', e)
  // e?.message ?? String(e): defense in depth, not the real fix -- daeh's
  // own job() used to throw a bare browser Event (no .message at all) for
  // a WebSocket error, producing exactly "FAILED: undefined" with zero
  // diagnostic value (confirmed live, mobile Safari). The real fix is in
  // daeh/lib/job.ts's bridgeWs; this just keeps any future non-Error
  // throw, from here or elsewhere, from ever regressing to "undefined"
  // again.
  out(`FAILED: ${e?.message ?? String(e)}`)
})
