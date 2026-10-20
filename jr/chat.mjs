#!/usr/bin/env node

// tg/ja/public/jr/chat.mjs -- interactive, multi-turn chat with an {{{1
// echo-offering Agent whose own job answers from an LLM (Tosh's sh-kind
// echo, ccddh.md's Ollama round). The basic plumbing test (run.js) stays
// untouched and minimal on purpose -- this is a deliberately separate
// script, not a refactor of it.
//
// One gate trade for the *whole* chat session, not one per line: job.ts's
// own relay phase already supports more than one message per Match (every
// ws-message after the first still just gets written to the Agent's own
// spawned job's stdin -- only the indataEOD sentinel ends it), so this
// just keeps the same job() generator open and pushes each typed line
// into a live outbox instead of opening a fresh gate-trade+match per
// line (round 56's own first attempt -- it worked, but paying and
// re-matching on every line doesn't feel like "a chat", and the Agent's
// own job was also still answering each line from a blank slate, with no
// memory of anything said earlier -- see tg/sh/jobs/echo/Makefile's own
// header for that half of the fix). The sentinel is sent once, when you
// quit (Ctrl-D), and payBack() happens once at the end -- pay once, chat
// freely.
//
// Env: same as run.js (TG_ISSUER_PK, TG_WS_URL, TG_ASSET_CODE, TG_JR_SK,
// TG_JR_NAME, TG_GRANT_TIMEOUT_MS, TG_MATCH_TIMEOUT_MS) -- registry
// auto-discovery works the same way too.

import readline from 'node:readline' // {{{1
import WebSocket from 'ws'
import { Keypair } from '@stellar/stellar-sdk'
import { generate_keypair } from 'daeh/sdk.js'
import { job } from 'daeh'
import { httpize } from 'daeh/util.mjs'
import { buyGrant, payBack } from './gate.js'

//function makeOutbox () {{{1
/** Live, push-based outbox -- same shape join.mjs's own uses (push()
 * resolves an already-waiting receive() immediately if there is one,
 * otherwise queues), not run.js's own pre-queued one-shot version. Lets
 * the chat loop below feed lines in as they're typed, one job() session
 * at a time, rather than opening a fresh one per line. */
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
 * loop starts sending lines. */
async function waitForType (gen, type) {
  let step = await gen.next()
  while (!step.done) {
    const event = step.value
    if (event.type === type) return event;
    if (event.type === 'error') throw event.error;
    step = await gen.next()
  }
  throw new Error(`chat: connection closed before a '${type}' event`);
}

//async function nextMessage (gen) {{{1
/** Drains gen until the next 'message' event (the Agent's own reply) --
 * skipping over 'output' (just confirms what *we* sent) along the way.
 * Returns null once the generator's done (the Agent closed the
 * connection), instead of throwing, since that's an ordinary way for a
 * chat to end, not a failure. */
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
  if (!process.env.TG_JR_SK) {
    const [sk] = (await generate_keypair()).split(' ')
    process.env.TG_JR_SK = sk
  }
  const sk = process.env.TG_JR_SK
  const pk = Keypair.fromSecret(sk).publicKey()
  // Fallback connect target if discovery below finds nothing -- kept, not
  // discarded, since catalog discovery only overwrites it on an actual hit.
  let wsUrl = process.env.TG_WS_URL ?? 'wss://qa.ws.tg.kloudoftrust.org/ja'
  process.env.TG_ASSET_CODE ??= 'ECHO' // must precede the catalog query below -- it's the lookup key

  if (!process.env.TG_ISSUER_PK) {
    const origin = new URL(wsUrl).origin // ws(s): is a WHATWG "special" scheme -- .origin drops the path, keeps scheme+host+port
    const registryUrl = `${httpize(origin)}/catalog/registry?assetCode=${process.env.TG_ASSET_CODE}`
    const res = await fetch(registryUrl)
    if (res.ok) {
      const entries = await res.json() // always an array now (possibly empty), never 404
      if (entries.length > 0) {
        const entry = entries[0] // server-sorted newest-registered first
        process.env.TG_ISSUER_PK = entry.issuerPk
        process.env.TG_ASSET_CODE = entry.assetCode
        if (entry.price) process.env.TG_PRICE = entry.price
        wsUrl = `${origin}/${entry.smName}` // the catalog, not wsUrl's own old path, says where to connect
        console.error('[chat] registry: found', entry)
      } else {
        console.error(`[chat] registry: no entry (${registryUrl})`)
      }
    } else {
      console.error(`[chat] registry: lookup failed (${registryUrl} -> ${res.status})`)
    }
  }
  if (!process.env.TG_ISSUER_PK) throw new Error('TG_ISSUER_PK not set, directly or via the catalog -- nobody to chat with');

  const actor = { app: 'jr', iss: { name: process.env.TG_JR_NAME ?? 'jr', pk }, sk, WebSocket, wsArgs: [wsUrl] }

  console.error('[chat] buying access (one trade for the whole session)...')
  const requesterKp = await buyGrant(line => console.error('[chat] gate:', line))
  console.error('[chat] gate grant confirmed')

  const outbox = makeOutbox()
  const gen = job(actor, {
    aud: 'echo', label: 'Echo', outbox,
    matchTimeoutMs: Number(process.env.TG_MATCH_TIMEOUT_MS ?? 30_000),
  })
  await waitForType(gen, 'matched')
  console.error('[chat] matched -- type away, Ctrl-D (or Ctrl-C) to end the session.')

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, prompt: '> ' })

  // Without this, Ctrl-C mid-conversation just kills the process outright
  // -- the WS connection becomes an abrupt TCP drop instead of a clean
  // close, and the Agent's own spawned job is left waiting on stdin until
  // Cloudflare's own edge eventually notices the dead socket, which is
  // NOT reliable: confirmed live, sometimes within seconds, sometimes
  // needing a manual kill on the Agent's own box.
  //
  // Deliberately does NOT wait for gen to fully drain (done:true) the way
  // the normal post-loop cleanup below does: that drain only completes
  // once the server echoes back the Agent's own ws-close, which can't
  // happen until the Agent's spawned job notices the sentinel -- and
  // that's agent.py's own `for line in sys.stdin` loop, which only checks
  // for EOF *between* lines, so it can't react until whatever reply it's
  // currently generating finishes (confirmed live: as long as that
  // reply's own latency, tens of seconds or more -- not something a
  // Ctrl-C should make the user sit through). Pushing the sentinel here
  // is enough on its own: it's picked up fast by the already-running
  // nextMessage(gen) loop (queued ahead of the still-pending reply, which
  // the Agent is still computing), and once it's on the wire, cleanup on
  // the Agent's own side proceeds independently of whether this process
  // is even still running to see it finish -- run.js on mba is a
  // long-lived, always-on process (launchd), not something this session
  // owns the lifecycle of.
  let interrupted = false
  process.on('SIGINT', async () => {
    if (interrupted) { console.error('\n[chat] forcing exit...'); process.exit(1); }
    interrupted = true
    console.error('\n[chat] interrupted -- ending session (Ctrl-C again to skip payback and exit now)...')
    outbox.push('context.job.stdin.end()')
    rl.close()
    const forceExit = setTimeout(() => {
      console.error('[chat] payBack timed out, exiting without it')
      process.exit(1)
    }, 8000)
    try {
      await payBack(requesterKp)
      console.error('[chat] paid back')
    } catch (err) {
      console.error('[chat] payBack failed:', err.message ?? err)
    }
    clearTimeout(forceExit)
    process.exit(0)
  })

  rl.prompt()
  for await (const line of rl) {
    if (!line.trim()) { rl.prompt(); continue; }
    // +'\n': readline strips the trailing newline from every line it
    // yields, but the Agent's own job (tg/sh/jobs/echo/Makefile, also
    // readline-based now) needs one to recognize a complete line at all
    // -- without it, this text just sits in its own input buffer forever,
    // confirmed live (a session that matched fine, then hung on the very
    // first reply). Never applies to the sentinel below -- job.ts's own
    // check is an exact string match against 'context.job.stdin.end()'.
    outbox.push(line + '\n')
    let reply
    try {
      reply = await nextMessage(gen)
    } catch (err) {
      console.error('[chat] error:', err.message ?? err)
      break;
    }
    if (reply === null) { console.error('[chat] connection closed'); break; }
    console.log(reply)
    rl.prompt()
  }

  // Skip this whole block if SIGINT already fired: that handler owns its
  // own sentinel-push/payBack/exit sequence (not draining gen fully --
  // see its own comment), and rl.close() inside it is exactly what ended
  // the loop above when the loop was idle at the prompt. Running this
  // too would double-push the sentinel and double-call payBack() in a
  // race against the handler's own in-flight one.
  if (!interrupted) {
    outbox.push('context.job.stdin.end()')
    let step = await gen.next()
    while (!step.done) step = await gen.next(); // drain to the final close
    await payBack(requesterKp)
    // step.value can be undefined here: the loop above may have already
    // driven gen all the way to its own 'ws-close' return (reply === null
    // broke the loop after nextMessage() already consumed that final
    // {done: true} step itself) -- the drain loop's own first gen.next()
    // call in that case just re-confirms done:true with no further value,
    // standard once-exhausted generator semantics, not a bug to work
    // around beyond not crashing on it.
    if (step.value) console.error('[chat]', step.value.message)
  }
}

main().catch(e => { // {{{1
  console.error('[chat] FAILED', e)
  process.exitCode = 1
})
