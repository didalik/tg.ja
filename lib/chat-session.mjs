// tg/ja/public/lib/chat-session.mjs -- the shared, asset-generic WS {{{1
// chat session driver for calc.mjs/echo.mjs (split out of what used to
// be one shared ja.mjs/ja.html, ccddh.md's "a dedicated page per test
// case" round): the gate trade + retry + Match/Relay + typed chat loop
// is identical either way -- only the asset code, the page's own copy,
// and whether to show the delegation heads-up ever differed, and those
// are now plain call-site parameters instead of runtime
// `aud === 'calc'` branching throughout.
//
import { put, reset, } from './util.mjs' // {{{1
import { generate_keypair, } from '@amissine/daeh/sdk.js'
import { job, } from '@amissine/daeh'
import { wsize, } from '@amissine/daeh/util.mjs'
import { buyGrant, payBack, } from '../jr/gate.js'

// gate.js/stellar.mjs read process.env.* (JI_PK, JA_PK, TG_ASSET_CODE,
// TG_PRICE, TG_GRANT_TIMEOUT_MS, TG_STELLAR_NETWORK, ...) -- same trick
// hx/public/tm.mjs uses to keep those reads from throwing in the browser:
// each one just comes back undefined and falls through to its own ??
// default, exactly as it would under Node.
window.process = { env: {} }

// This file's own put() is the simpler copy (no scroll) of {{{1
// hx/public/lib/util.mjs's original -- keeping the animated-scroll-to-
// bottom behavior local to this module rather than changing the shared
// helper, since nothing else using it needs it.
const out = m => {
  put(`<div>${m}</div>`)
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
}

//function makeOutbox () {{{1
/** Live, push-based outbox -- same shape jr/chat.mjs's own uses (push()
 * resolves an already-waiting receive() immediately if there is one,
 * otherwise queues), not a pre-queued one-shot version. Lets the chat
 * loop below feed lines in as they're typed, one job() session at a
 * time, instead of sending a single hardcoded line and ending
 * immediately. */
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
  throw new Error(`jr: connection closed before a '${type}' event`);
}

//function isMatchTimeout (err) {{{1
/** True only for daeh/lib/job.ts's own match-timeout failure ("no match
 * found[ within Nms]") -- the one failure this page can actually fix by
 * trying again: this attempt's own gate trade just paid a seller that
 * never showed up to claim it (a dead transient JA's own stale resale,
 * say -- see tg/ja/jobs/sell/sell.mjs's own SELL_AMOUNT=1 comment for
 * why one retry is normally enough), and that same payment is also what
 * consumed whatever inventory that dead offer was still holding, so a
 * fresh attempt's own trade should now land on a live seller instead.
 * Any other failure (a bad asset code, Horizon down, a real network
 * error) is left to surface as-is -- retrying wouldn't fix those, and
 * silently masking them would just hide a real problem. */
function isMatchTimeout (err) {
  return /no match found/.test(err?.message ?? '');
}

const MAX_ATTEMPTS = 3 // {{{1
// Bounded, not unlimited: SELL_AMOUNT=1 means at most one dead reseller's
// own offer should ever stand between a buyer and a live seller at any
// given moment in the common case -- one retry already clears it, one
// more covers the unlikely case of a couple dying in close succession.
// A persistent failure past that is treated as real, not retried forever.

const GRANT_TIMEOUT_MS = 30_000 // {{{1
// Caught live: a visitor clicked bridge.mjs's own "chat with your own
// echo" link after its session's own TTL had already expired (self-
// issued/resold identities retract their own offer on a clean shutdown)
// -- buyGrant() has no timeout of its own by default (daeh's own "wait
// forever" posture, same as db's original tm.js), so the buy offer just
// sat there, unfillable, forever, with no error and no way out short of
// reloading. This gives it the same bound matchTimeoutMs already has --
// buyGrant() itself already cancels the stale buy offer cleanly on
// timeout, this only had to be wired up. Not retried on timeout, unlike
// a match timeout: a fresh attempt's own trade would target the exact
// same (still-dead) identity, so retrying here can't ever help.

//async function connectAndMatch (wsUrl, assetCode, issuerPk, aud, label) {{{1
/** The gate trade + WS Match, retried on a match timeout only (see
 * isMatchTimeout() above). Each attempt is a genuinely fresh one -- new
 * keypair, new trade, new WS identity -- not a retry of the same actor:
 * the failed attempt's own requesterKp has nothing to pay back (no Job
 * ever ran) and nothing else to clean up, so it's simply discarded. */
async function connectAndMatch (wsUrl, assetCode, issuerPk, aud, label) {
  for (let attempt = 1; ; attempt++) {
    const [sk, pk] = (await generate_keypair()).split(' ')
    window.process.env.TG_ASSET_CODE = assetCode
    window.process.env.JI_PK = issuerPk
    delete window.process.env.JA_PK // a stale value from a previous failed attempt must never leak into this one's own targetPk below -- buyGrant() sets this fresh, from this attempt's own trade, every time
    // Set before buyGrant() runs, not left for it to generate its own --
    // buyGrant() reads TG_JR_SK when present, falling back to a fresh
    // Keypair.random() only when it's unset, so this is what makes the
    // Stellar keypair that actually places the gate trade the *same* one
    // signing this attempt's own WS handshake below (actor.sk/iss.pk).
    // Without it, matchRO()'s own Agent-side targetPk check (tg/ws/src/
    // wsfsm.ts) can never succeed for ANY request, not just a dead-
    // reseller one: the Agent resolves its own targetPk from the trade's
    // real counterparty, but this page would be connecting under a
    // completely unrelated identity of its own every time.
    window.process.env.TG_JR_SK = sk

    const actor = { app: 'jr', iss: { name: 'jr', pk }, sk, WebSocket, wsArgs: [wsUrl] }
    let requesterKp
    try {
      requesterKp = await buyGrant(line => out(`gate: ${line}`), GRANT_TIMEOUT_MS)
    } catch (err) {
      throw new Error(`that identity's own offer never filled -- its disposable session may have already ended. Go back and start a fresh one. (${err.message})`)
    }
    const seller = window.process.env.JA_PK === window.process.env.JI_PK ? 'issuer' : 'reseller'
    out(`gate granted by ${seller}`)

    const outbox = makeOutbox()
    const gen = job(actor, {
      aud, label, outbox,
      // Which specific Agent's offer to match -- the one this Requester's
      // own gate trade just paid (JA_PK, when a reseller's own trade set it
      // differently from JI_PK), not just any offer sharing this aud (see
      // daeh/lib/sdk.js's MRT.setTarget -- ccddh.md's Match-pairing round).
      targetPk: window.process.env.JA_PK ?? window.process.env.JI_PK,
      matchTimeoutMs: 30_000,
    })
    try {
      await waitForType(gen, 'matched')
      return { gen, outbox, requesterKp };
    } catch (err) {
      if (!isMatchTimeout(err) || attempt >= MAX_ATTEMPTS) throw err;
      out(`that seller didn't respond -- trying again...`)
    }
  }
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

//export async function runChatSession ({ assetCode, label, matchedMessage, showDelegationHeadsUp }) {{{1
/** The whole page, generic over which Job it's driving: reads issuerPk
 * from the URL, does the gate trade + retry + Match (connectAndMatch()),
 * shows matchedMessage (and, if showDelegationHeadsUp, an extra note
 * once matched against a reseller rather than the real issuer -- never
 * relevant for calc, which is never resold today), then wires up the
 * typed chat form and End Session button. Identical shape for every
 * asset this drives; calc.mjs/echo.mjs's own entry points just supply
 * what differs. Handles its own top-level failure (same "FAILED: ..."
 * shape the old shared ja.mjs had) so each entry point can just call
 * this and nothing else. */
export async function runChatSession ({ assetCode, label, matchedMessage, showDelegationHeadsUp = false }) {
  reset({ content: document.getElementById('content1') })

  try {
    // Every JR connects via the same fixed /jr path regardless of which
    // page or asset is driving it.
    const wsUrl = wsize(`${location.origin}/jr`)

    // intro.mjs's own renderCatalog (and bridge.mjs's own try-it links)
    // link here with just ?issuerPk= -- assetCode is this page's own,
    // not a query param any more, now that each asset gets its own
    // dedicated page instead of sharing one generic one.
    const picked = new URLSearchParams(location.search)
    const issuerPk = picked.get('issuerPk')
    if (!issuerPk) {
      out('Pick this Job from the <a href="/">home page</a> first -- this page needs ?issuerPk= to know who to buy from.')
      return;
    }
    const aud = assetCode.toLowerCase()
    if (picked.get('description')) out(picked.get('description'))

    const { gen, outbox, requesterKp } = await connectAndMatch(wsUrl, assetCode, issuerPk, aud, label)
    out(matchedMessage)
    // ECHO matched against a reseller, not the real issuer, means this is
    // a visitor's own sh-kind echo (tg/sh/jobs/echo/echo.mjs) -- either
    // their own resale of the Owner's inventory or their own self-issued
    // one, both the same handler. Unlike the Owner's own ja-kind echo
    // (tg/ja/jobs/echo/'s plain cat, never delegates), this one pays
    // JA2's real calc Job for exact arithmetic -- a real, separate gate
    // trade + WS match happening invisibly, a few extra seconds a
    // first-time visitor has no way to otherwise know is coming rather
    // than a stall.
    if (showDelegationHeadsUp && window.process.env.JA_PK !== issuerPk) {
      out('(heads up: this isn\'t the Owner\'s own echo -- if you ask it real arithmetic, it pays a separate, real Job for the exact answer, which takes a few extra seconds. That\'s the delegation working, not lag.)')
    }

    // Disabled by default in the markup (nothing to type into until
    // matched) -- enable now that there's actually a session to chat in.
    document.getElementById('chatInput').disabled = false
    document.getElementById('sendBtn').disabled = false
    document.getElementById('endBtn').disabled = false

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
  } catch (e) {
    console.error('FAILED', e)
    // e?.message ?? String(e): defense in depth, not the real fix -- daeh's
    // own job() used to throw a bare browser Event (no .message at all) for
    // a WebSocket error, producing exactly "FAILED: undefined" with zero
    // diagnostic value (confirmed live, mobile Safari). The real fix is in
    // daeh/lib/job.ts's bridgeWs; this just keeps any future non-Error
    // throw, from here or elsewhere, from ever regressing to "undefined"
    // again.
    out(`FAILED: ${e?.message ?? String(e)}`)
  }
}
