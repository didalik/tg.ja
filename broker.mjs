#!/usr/bin/env node

// tg/ja/public/broker.mjs -- promoted copy of tg/sh/broker.mjs (same {{{1
// reason broker-client.mjs/find-pk.mjs are promoted copies, not imports:
// this submodule deliberately never depends on tg/sh at all -- it's
// meant to be independently cloneable, and tg/sh is a *private* repo a
// real demo visitor has no access to clone. jr/bridge.mjs used to reach
// this file by a plain filesystem path into a required sibling `sh`
// clone instead (SH_DIR) -- caught live: DEMO_GUIDE.md's own one-time
// setup was telling a real visitor to `git clone
// https://github.com/didalik/sh.git`, which fails for anyone but Дід
// Alik. This copy removes that requirement entirely -- bridge.mjs now
// imports it as a plain local file, same as every other jr/*.mjs import.
// The one shared HTTP server every Horizon-writing caller on this box
// (or a Termux device) goes through, instead of touching
// server.loadAccount()/submitTransaction() directly. Built after two
// real incidents in one day: (1) concurrent callers sharing one Stellar
// account racing each other's own sequence numbers (today's
// "sell/calc/buyinvite colliding" class of bug, previously only papered
// over by reload-and-retry); (2) a Horizon 429 turning into a sustained,
// amplified crash storm because every one of several independent,
// uncoordinated processes kept retrying on its own schedule. One global
// FIFO queue, one atomic loadAccount->build->sign->submit per request,
// fixes the first outright and at least reduces the second (429-aware
// backoff itself is still a separate, later piece -- see dqad.md-adjacent
// design notes, not duplicated here).
//
// Not partitioned per secret key/account -- every /submit call waits its
// turn regardless of which identity it's for. There's no sequence-race
// reason to serialize *across* accounts, but today's actual incident was
// IP-level rate limiting, which a single box-wide queue helps with too;
// at this project's real volume (a handful of transactions a minute),
// the latency cost of one global queue is negligible.
//
// Deliberately generic about *what* gets submitted: callers build
// Operations exactly as they already do (Operation.payment(...),
// Operation.changeTrust(...), ...) and just serialize the result to XDR
// instead of handing it to their own TransactionBuilder -- see
// ./broker-client.mjs's own header. This needs no allowlist of operation
// types; anything the SDK can build, this can submit.
//
// Localhost-bound, no auth layer -- same trust boundary every existing
// script already assumes (they already read secret keys off local disk).
//
// Env:
//   SH_BROKER_PORT -- optional, defaults to 8793
//
// Errors: a rejected submission forwards Horizon's own status code and
// error body verbatim (result_codes, etc.) -- no retry/backoff logic
// lives here. Malformed requests get a plain 400 from this file itself.

import http from 'node:http' // {{{1
import { BASE_FEE, Keypair, Memo, TransactionBuilder, xdr } from '@stellar/stellar-sdk'
import { ensureFunded, networkPassphrase, server } from '@amissine/daeh/stellar.mjs'

let queueTail = Promise.resolve() // {{{1

//function enqueue (fn) {{{1
/** Runs fn() only once every previously enqueued fn() has fully settled
 * (resolved or rejected) -- the actual fix for Stellar's own sequence-
 * number races between concurrent callers sharing one account: a
 * loadAccount()'s own snapshot going stale between it and a later
 * submitTransaction() is the real failure mode, not something reload-
 * and-retry can do more than paper over after the fact. One shared
 * queue for this whole process, not one per caller -- see this file's
 * own header for why that's the right granularity here. */
function enqueue (fn) {
  const result = queueTail.then(fn, fn) // run fn() either way, even after a prior rejection
  queueTail = result.then(() => {}, () => {}) // keep the chain alive regardless of outcome
  return result;
}

//async function handleSubmit (secretKey, operationsXdr, memoXdr) {{{1
/** The one atomic unit this whole file exists to serialize: fund (if
 * needed), load the account's current sequence number, build a
 * transaction from the caller's own already-built operations (plus an
 * optional transaction-level memo -- invite.mjs's own Memo.hash, e.g.
 * --, which isn't an Operation and so can't ride in the operations
 * array itself), sign, and submit -- all under the same enqueue() call,
 * so nothing else touching this process's own queue can observe a stale
 * sequence number in between. Returns Horizon's own submission result
 * as-is. */
async function handleSubmit (secretKey, operationsXdr, memoXdr) {
  const kp = Keypair.fromSecret(secretKey)
  const ops = operationsXdr.map(opXdr => xdr.Operation.fromXDR(opXdr, 'base64'))
  await ensureFunded(kp) // also what triggers stellar.mjs's own ensureInit()
  const account = await server.loadAccount(kp.publicKey())
  const builderOpts = { fee: BASE_FEE, networkPassphrase }
  if (memoXdr) builderOpts.memo = Memo.fromXDRObject(xdr.Memo.fromXDR(memoXdr, 'base64'))
  const builder = new TransactionBuilder(account, builderOpts)
  for (const op of ops) builder.addOperation(op)
  const tx = builder.setTimeout(60).build()
  tx.sign(kp)
  return server.submitTransaction(tx);
}

function readBody (req) { // {{{1
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk; })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  });
}

function sendJson (res, status, body) { // {{{1
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(json)
}

//export function startBroker ({ port } = {}) {{{1
/** Starts the broker, bound to localhost only. Returns the underlying
 * http.Server (e.g. for a caller to .close() it). Exported, not just
 * runnable as a script, so a combined service (or jr/bridge.mjs) can
 * embed this directly in the same process as its Job-offering loops,
 * rather than running it as a separate process it then has to talk to
 * over HTTP itself. */
export function startBroker ({ port = Number(process.env.SH_BROKER_PORT ?? 8793) } = {}) {
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, 200, { ok: true }); return;
      }
      if (req.method === 'POST' && req.url === '/submit') {
        let body
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' }); return;
        }
        const { secretKey, operations, memo } = body
        if (!secretKey || !Array.isArray(operations) || operations.length === 0) {
          sendJson(res, 400, { error: 'secretKey and a non-empty operations array are required' })
          return;
        }
        try {
          const result = await enqueue(() => handleSubmit(secretKey, operations, memo))
          sendJson(res, 200, result)
        } catch (err) {
          const status = err.response?.status ?? 500
          const data = err.response?.data ?? { error: err.message }
          sendJson(res, status, data)
        }
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 500, { error: err.message })
    }
  })
  httpServer.listen(port, '127.0.0.1', () => {
    console.log(`[broker] listening on http://127.0.0.1:${port}`)
  })
  return httpServer;
}

if (import.meta.url === `file://${process.argv[1]}`) { // {{{1
  startBroker()
}
