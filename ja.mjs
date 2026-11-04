import { put, reset, } from './lib/util.mjs' // {{{1
import { generate_keypair, } from '@amissine/daeh/sdk.js'
import { job, } from '@amissine/daeh'
import { wsize, } from '@amissine/daeh/util.mjs'
import { buyGrant, payBack, } from './jr/gate.js'

// gate.js/stellar.mjs read process.env.* (JI_PK, JA_PK, TG_ASSET_CODE, {{{1
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
  // Every JR now connects via the same fixed /jr path (ccddh.md's
  // "retiring the registry" round) -- the old "this page's own URL IS
  // the connect URL" trick (reusing whatever path this page happened to
  // be served at) no longer applies, since every Requester, browser or
  // Node, now connects the same fixed way regardless of where it's served
  // from.
  const wsUrl = wsize(`${location.origin}/jr`)

  const [sk, pk] = (await generate_keypair()).split(' ')

  // intro.mjs's own renderCatalog links here with ?assetCode=&issuerPk=
  // straight from /jobs (cnj.md's own Job model: a Job *is* just a name
  // and its real issuer) -- no more registry, no more realIssuerPk/
  // smName grouping to resolve: Stellar's own DEX already picks up
  // whichever account -- the real issuer or any reseller holding real,
  // fungible inventory of that exact asset -- has the best current
  // price, with no discovery step of its own needed at all.
  const picked = new URLSearchParams(location.search)
  const assetCode = picked.get('assetCode')
  const issuerPk = picked.get('issuerPk')
  if (!assetCode || !issuerPk) {
    out('Pick a Job from the <a href="/">home page</a> first -- this page needs ?assetCode=&issuerPk= to know what to buy.')
    return;
  }
  // intro.mjs's own BROWSER_UNSUPPORTED comment: csr is listed now, but
  // this generic chat flow can't actually drive it (it needs a real
  // {csr, network, email} payload, not a typed line) -- guarded here,
  // before buyGrant() below places any real trade, rather than hiding it
  // from the catalog outright.
  if (assetCode === 'CSR') {
    out('csr is Work In Progress -- not requestable from the browser yet. Use the Node-side jr/csr.mjs for now.')
    return;
  }
  window.process.env.TG_ASSET_CODE = assetCode
  window.process.env.JI_PK = issuerPk
  const aud = assetCode.toLowerCase()
  if (picked.get('description')) out(picked.get('description'))

  const actor = {
    app: 'jr',
    iss: { name: 'jr', pk },
    sk,
    WebSocket,
    wsArgs: [wsUrl],
  }

  const requesterKp = await buyGrant(line => out(`gate: ${line}`))
  const seller = window.process.env.JA_PK === window.process.env.JI_PK ? 'issuer' : 'reseller'
  out(`gate granted by ${seller}`)

  const outbox = makeOutbox()
  const gen = job(actor, {
    aud, label: aud === 'calc' ? 'Calc' : 'Echo', outbox,
    // Which specific Agent's offer to match -- the one this Requester's
    // own gate trade just paid (JA_PK, when a reseller's own trade set it
    // differently from JI_PK), not just any offer sharing this aud (see
    // daeh/lib/sdk.js's MRT.setTarget -- ccddh.md's Match-pairing round).
    targetPk: window.process.env.JA_PK ?? window.process.env.JI_PK,
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
