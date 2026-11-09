// tg/ja/public/broker-client.mjs -- promoted copy of tg/sh/broker-client.mjs {{{1
// (same reason tg/post.mjs/tg/ja/public's own find-pk.mjs are promoted
// copies, not imports: this submodule deliberately never depends on
// tg/sh at all -- it's meant to be independently cloneable, and tg/sh
// may not even be present as a sibling directory). Lives at this
// submodule's own root, not under jr/, so jr/*.mjs can reach it with a
// plain ../broker-client.mjs, same placement reasoning find-pk.mjs has.
//
// Every Horizon-writing caller here (jr/gate.js, and anything built on
// it) imports this instead of touching server.loadAccount()/
// submitTransaction() directly -- see tg/sh/broker.mjs's own header for
// the full design (one global FIFO queue per box, atomic
// loadAccount->build->sign->submit, Horizon's own error forwarded
// verbatim). On a device running both this submodule and tg/sh (the
// demo's own transient identity, buying Jobs via jr/ while also offering
// its own echo via tg/sh's run.js), both talk to the same one broker.
//
// Env:
//   SH_BROKER_URL  -- optional, defaults to http://127.0.0.1:${SH_BROKER_PORT}
//   SH_BROKER_PORT -- optional, defaults to 8793 (see tg/sh/broker.mjs)
//
// In a browser (ja.mjs, via jr/gate.js's buyGrant/payBack), neither env
// var is ever set -- there's no process.env to set it on -- so this
// used to fall through to the same localhost default regardless, and a
// real visitor's own browser would try to fetch 127.0.0.1:8793: *their
// own machine*, not this server, where nothing is ever listening unless
// they happen to also be running the local bridge (whose own embedded
// broker coincidentally listens on that same port, which is exactly
// what masked this for months of testing against it, not against a
// plain Owner's-echo request). Caught live: a real visitor's own plain
// echo request failing with a generic NetworkError. A lone browser
// visitor's own fresh keypair never has a concurrent writer sharing it
// either (the actual reason the broker exists at all, see tg/sh/
// broker.mjs's own header) -- so this bypasses it entirely in a
// browser, submitting directly instead, regardless of what env vars
// happen to be set.

import { BASE_FEE, Keypair, TransactionBuilder } from '@stellar/stellar-sdk' // {{{1
import { ensureFunded, networkPassphrase, server } from '@amissine/daeh/stellar.mjs'

//export async function submit ({ secretKey, operations, memo }) {{{1
/** operations: an array of already-built Operation objects
 * (Operation.payment(...), Operation.changeTrust(...), ...) -- this
 * serializes each to XDR itself, callers don't need to. memo: an
 * optional, already-built Memo (e.g. Memo.hash(...)) -- a transaction-
 * level field, not an Operation, so it can't ride in the operations
 * array; Memo itself has no .toXDR() of its own, only .toXDRObject()
 * does. Returns the broker's own forwarded Horizon submission result
 * (same shape server.submitTransaction() itself returns) on success. On
 * a rejected submission, throws an Error with .response = {status,
 * data} (Horizon's own error body) -- the same shape every existing
 * caller's own catch block already expects from calling
 * server.submitTransaction() directly, so call sites need minimal
 * changes to switch over. */
export async function submit ({ secretKey, operations, memo }) {
  if (typeof window !== 'undefined') return submitDirect({ secretKey, operations, memo });

  const brokerUrl = process.env.SH_BROKER_URL
    ?? `http://127.0.0.1:${process.env.SH_BROKER_PORT ?? 8793}`
  const res = await fetch(new URL('/submit', brokerUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      secretKey,
      operations: operations.map(op => op.toXDR('base64')),
      ...(memo ? { memo: memo.toXDRObject().toXDR('base64') } : {}),
    }),
  })
  const body = await res.json()
  if (!res.ok) {
    throw Object.assign(
      new Error(body.title ?? body.error ?? 'broker submit failed'),
      { response: { status: res.status, data: body } },
    );
  }
  return body;
}

//async function submitDirect ({ secretKey, operations, memo }) {{{1
/** The browser's own path -- mirrors tg/sh/broker.mjs's own
 * handleSubmit() (fund if needed, load the current sequence number,
 * build, sign, submit), just without the enqueue() serialization that
 * exists there specifically for concurrent callers sharing one account
 * -- never the case for a lone browser visitor's own fresh keypair.
 * server.submitTransaction() already throws with the same .response =
 * {status, data} shape this file's own doc comment promises, so no
 * reshaping needed here either. */
async function submitDirect ({ secretKey, operations, memo }) {
  const kp = Keypair.fromSecret(secretKey)
  await ensureFunded(kp)
  const account = await server.loadAccount(kp.publicKey())
  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase, ...(memo ? { memo } : {}) })
  for (const op of operations) builder.addOperation(op)
  const tx = builder.setTimeout(60).build()
  tx.sign(kp)
  return server.submitTransaction(tx);
}
