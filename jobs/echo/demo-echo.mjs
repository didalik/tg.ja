#!/usr/bin/env node

// tg/ja/public/jobs/echo/demo-echo.mjs -- a deterministic stand-in for {{{1
// the real LLM-backed echo (tg/sh/jobs/echo/agent.py), for a device that
// can't run a local model at all: confirmed live, repeatedly, even
// llama3.2:1b's own model load gets OOM-killed on a 3.6GB Android phone,
// at the exact same step, every time. No LLM, no tool-calling reasoning
// -- just a plain heuristic ("does this line look like a bare arithmetic
// expression?") deciding whether to pay JA2's real calc Job for the
// answer. The point isn't to be smart about it; it's to genuinely
// exercise the same echo-pays-calc mechanic agent.py's own ask_calc()
// does, with no Python/Ollama dependency at all.
//
// Reuses ../../jr/gate.js's own buyGrant/payBack/trust directly (same
// submodule, not a separate copy) -- one full gate trade + Match/Relay
// round trip against JA2's real CALC Job, per arithmetic line, same
// shape tg/sh/ask-calc.mjs's own already-proven mechanism uses, just
// reached through this submodule's own gate.js instead of sh's.
//
// Lives here (jobs/echo/), not tg/ja/jobs/echo/ -- that one stays the
// trivial `cat` pass-through Дід Alik's/JA2's own production echo
// Agents actually run; this is specifically the standalone clone's own
// copy, for a demo device with no real LLM available.
//
// Env: TG_WS_URL/TG_JR_WS_URL -- optional, default to the qa deploy.

import readline from 'node:readline' // {{{1
import WebSocket from 'ws'
import { Keypair } from '@stellar/stellar-sdk'
import { generate_keypair } from '@amissine/daeh/sdk.js'
import { job } from '@amissine/daeh'
import { httpize } from '@amissine/daeh/util.mjs'
import { buyGrant, payBack } from '../../jr/gate.js'

//function looksLikeArithmetic (line) {{{1
/** Same character set calc.mjs's own tokenizer accepts -- digits, the
 * four arithmetic operators, parens and decimals, nothing else, with
 * at least one digit. Not an NLU heuristic on purpose -- '2+2' and
 * '17 * 23 + 4' match; 'what is 2+2?' does not (the '?' alone rules it
 * out) -- matching the honest "deterministic stand-in" framing, not a
 * disguised attempt at real language understanding. */
function looksLikeArithmetic (line) {
  return /^[-+*/().\d\s]+$/.test(line) && /\d/.test(line);
}

//function makeOutbox () {{{1
/** Same one-shot outbox as every other jr/*.mjs file's own. */
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

//async function calcIssuerPk () {{{1
/** The real CALC issuer's own PK, straight off the live /jobs catalog --
 * never hardcoded, same "discover, don't hardcode" posture
 * sell-approve.mjs's own realIssuerOf already has. Resolved once, not
 * per line -- it can't change mid-session. */
async function calcIssuerPk () {
  const wsUrl = process.env.TG_WS_URL ?? 'wss://qa.ws.tg.kloudoftrust.org/ja'
  const jobsUrl = new URL('/jobs', httpize(wsUrl))
  const res = await fetch(jobsUrl)
  if (!res.ok) throw new Error(`calcIssuerPk: GET ${jobsUrl} -> ${res.status}`);
  const jobs = await res.json()
  const entry = jobs.find(j => j.name === 'CALC')
  if (!entry) throw new Error('calcIssuerPk: no CALC entry posted to /jobs');
  return entry.issuerPk;
}

//async function askCalc (expression, issuerPk) {{{1
/** One full gate trade + Match/Relay round trip against JA2's real CALC
 * Job -- same shape tg/sh/ask-calc.mjs's own already-proven mechanism,
 * just reached through this submodule's own gate.js instead of sh's. A
 * fresh, disposable keypair per call (same posture ask-calc.mjs's own
 * has) -- this is paying for one answer, not establishing an identity. */
async function askCalc (expression, issuerPk) {
  const [sk, pk] = (await generate_keypair()).split(' ')
  const kp = Keypair.fromSecret(sk)

  process.env.JI_PK = issuerPk
  process.env.TG_ASSET_CODE = 'CALC'
  process.env.TG_JR_SK = sk

  // No separate trust() call here -- buyGrant() already establishes
  // trust to the exact same asset (TG_ASSET_CODE/JI_PK) before buying
  // it, same as tg/sh/ask-calc.mjs's own simpler usage already proves.
  // An extra one here was both redundant and buggy: trust() touches
  // `server` directly, which stellar.mjs only lazily initializes via
  // ensureFunded() -- called inside buyGrant() itself, not before it
  // (caught live: a real "Cannot read properties of undefined (reading
  // 'loadAccount')" crash on the very first call).
  const requesterKp = await buyGrant(line => console.error('[demo-echo] calc gate:', line))

  const wsUrl = process.env.TG_JR_WS_URL ?? 'wss://qa.ws.tg.kloudoftrust.org/jr'
  const actor = { app: 'jr', iss: { name: 'jr', pk }, sk, WebSocket, wsArgs: [wsUrl] }
  const outbox = makeOutbox()
  outbox.push(expression)
  outbox.push('context.job.stdin.end()') // sentinel -- see daeh/lib/job.ts's indataEOD handling

  const gen = job(actor, {
    aud: 'calc', label: 'Calc', outbox, targetPk: issuerPk,
    matchTimeoutMs: Number(process.env.TG_MATCH_TIMEOUT_MS ?? 30_000),
  })
  let step = await gen.next()
  let answer
  while (!step.done) {
    const event = step.value
    if (event.type === 'message') answer = event.payload.sub;
    if (event.type === 'error') throw event.error;
    step = await gen.next()
  }
  await payBack(requesterKp)
  if (answer === undefined) throw new Error('askCalc: no answer received before the connection closed');
  return answer;
}

const rl = readline.createInterface({ input: process.stdin }) // {{{1
let issuerPkPromise // resolved lazily, once -- no reason to hit /jobs before the first real need

// for await, not rl.on('line', ...): askCalc() mutates process.env (JI_PK/
// TG_ASSET_CODE/TG_JR_SK) for buyGrant()'s own sake, same as every other
// jr/*.mjs file -- two overlapping calls would stomp on each other's env.
// This serializes lines one at a time instead, same as calc.mjs's own
// single-threaded handling already is (harmlessly, there, since it does
// no async work at all).
for await (const rawLine of rl) {
  const line = rawLine.trim()
  if (!line) continue;
  if (looksLikeArithmetic(line)) {
    try {
      issuerPkPromise ??= calcIssuerPk()
      const issuerPk = await issuerPkPromise
      const answer = await askCalc(line, issuerPk)
      // .trim(), not a bare template -- answer already carries its own
      // trailing newline (calc.mjs's own stdout write, relayed verbatim
      // as the WS message's own payload), so appending another one
      // doubled up into a real blank line in this process's own stdout
      // (caught live).
      process.stdout.write(`${answer.trim()}\n`)
    } catch (err) {
      process.stdout.write(`error: calc Job failed: ${err.message}\n`)
    }
  } else {
    process.stdout.write(`${line}\n`)
  }
}
