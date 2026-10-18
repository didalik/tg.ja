#!/usr/bin/env node

// tg/ja/public/jr/chat.mjs -- interactive, multi-turn chat with an {{{1
// echo-offering Agent whose own job answers from an LLM (Tosh's sh-kind
// echo, ccddh.md's Ollama round) -- not a protocol change, just one
// gate trade + WS match + relay per line typed, repeated in a loop. The
// basic plumbing test (run.js) stays untouched and minimal on purpose --
// this is a deliberately separate script, not a refactor of it, so a
// real multi-turn chat doesn't creep into what run.js exists to prove.
//
// "Multi-turn" here means repeated one-shot requests, not a longer-lived
// WS session -- echo's own relay phase still ends after exactly one
// message each time (same indataEOD sentinel run.js already uses), so
// each line typed really is its own fresh gate trade. The *identity*
// doing the buying is set up once per chat session, though, not once
// per line -- same TG_JR_SK the whole way through, so only the first
// question pays for a fresh account/trustline; later ones just buy.
//
// Env: same as run.js (TG_ISSUER_PK, TG_WS_URL, TG_ASSET_CODE, TG_JR_SK,
// TG_JR_NAME, TG_GRANT_TIMEOUT_MS, TG_MATCH_TIMEOUT_MS) -- registry
// auto-discovery works the same way too, just resolved once at startup
// instead of per message.

import readline from 'node:readline' // {{{1
import WebSocket from 'ws'
import { Keypair } from '@stellar/stellar-sdk'
import { generate_keypair } from 'daeh/sdk.js'
import { job } from 'daeh'
import { httpize } from 'daeh/util.mjs'
import { buyGrant, payBack } from './gate.js'

//function makeOutbox (message) {{{1
/** One-shot outbox carrying a single caller-supplied message, instead of
 * run.js's own hardcoded 'hello from jr' -- otherwise identical. */
function makeOutbox (message) {
  const queue = [message, 'context.job.stdin.end()']
  return {
    push () {}, // never called from outside here -- nothing to push after construction
    receive () {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise(() => {}); // drained -- nothing more to say, same as run.js's own
    },
  };
}

//async function ask (actor, message) {{{1
/** One full gate-trade + WS-match + relay round trip for a single
 * message -- the same sequence run.js's own main() does once, pulled
 * out so the chat loop below can repeat it per line typed. */
async function ask (actor, message) {
  const kp = Keypair.fromSecret(actor.sk)
  const requesterKp = await buyGrant(line => console.error('[chat] gate:', line))
  const outbox = makeOutbox(message)
  const gen = job(actor, {
    aud: 'echo', label: 'Echo', outbox,
    matchTimeoutMs: Number(process.env.TG_MATCH_TIMEOUT_MS ?? 30_000),
  })
  let reply, jobError
  let step = await gen.next()
  while (!step.done) {
    const event = step.value
    if (event.type === 'message') reply = event.payload.sub
    else if (event.type === 'error') jobError = event.error
    step = await gen.next()
  }
  if (jobError) throw jobError;
  if (!reply) throw new Error('ask(): no reply received');
  await payBack(requesterKp)
  return reply;
}

async function main () { // {{{1
  if (!process.env.TG_JR_SK) { // {{{2 set once for the whole session, same
    // reasoning as join.mjs's own main() -- a stable identity across every
    // ask() in this chat, not a fresh one per line.
    const [sk] = (await generate_keypair()).split(' ')
    process.env.TG_JR_SK = sk
  } // }}}2
  const sk = process.env.TG_JR_SK
  const pk = Keypair.fromSecret(sk).publicKey()
  const wsUrl = process.env.TG_WS_URL ?? 'wss://qa.ws.tg.kloudoftrust.org/ja'

  if (!process.env.TG_ISSUER_PK) { // {{{2 same registry auto-discovery as
    // run.js's own main(), just resolved once here instead of per message.
    const registryUrl = `${httpize(wsUrl)}/registry`
    const res = await fetch(registryUrl)
    if (res.ok) {
      const entry = await res.json()
      process.env.TG_ISSUER_PK = entry.issuerPk
      if (entry.assetCode) process.env.TG_ASSET_CODE = entry.assetCode
      if (entry.price) process.env.TG_PRICE = entry.price
      console.error('[chat] registry: found', entry)
    } else {
      console.error(`[chat] registry: no entry (${registryUrl} -> ${res.status})`)
    }
  } // }}}2
  if (!process.env.TG_ISSUER_PK) throw new Error('TG_ISSUER_PK not set, directly or via the registry -- nobody to chat with');
  process.env.TG_ASSET_CODE ??= 'ECHO'

  const actor = { app: 'jr', iss: { name: process.env.TG_JR_NAME ?? 'jr', pk }, sk, WebSocket, wsArgs: [wsUrl] }

  console.error('[chat] each line is its own gate trade + request -- Ctrl-D to quit.')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, prompt: '> ' })
  rl.prompt()
  for await (const line of rl) {
    if (!line.trim()) { rl.prompt(); continue; }
    try {
      console.log(await ask(actor, line))
    } catch (err) {
      console.error('[chat] error:', err.message ?? err)
    }
    rl.prompt()
  }
}

main().catch(e => { // {{{1
  console.error('[chat] FAILED', e)
  process.exitCode = 1
})
