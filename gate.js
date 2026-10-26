// tg/ja/public/gate.js -- the Toll Gate's gate mechanism, Agent side: a {{{1
// Stellar-DEX-based gate for the Agent, same mechanism as db's (and hx's
// TM before that, see hx/public/src/demoit/job.js's runMonitor) --
// reimplemented directly against @stellar/stellar-sdk, no vault/asset-
// config machinery needed, just the underlying Stellar operations.
//
// Promoted here from tg/ja/gate.js (ccddh.md's "publish daeh, promote the
// Agent-offering flow" round, same move rtoj.mjs/find-pk.mjs already made
// into daeh): a standalone clone of this repo alone never had this file at
// all, so there was no way to actually *become* a competing Agent, only to
// *request* a Job (jr/) -- only daeh's own import below needed to change
// (bare specifier, resolved via node_modules once daeh is npm-published),
// nothing else. tg/ja/gate.js stays behind unchanged, still what Дід
// Alik's/JA2's own toll_gate_reset/toll_gate_calc services run.
//
// The Agent issues a small custom asset from its own account (issuers don't
// need a trustline to their own asset, so no separate issuer account is
// needed) and places a sell offer for 1 unit at a low XLM price. Once
// someone's matching buy trade executes against it -- observed by streaming
// the Agent's own trade effects -- the gate is open and grant() resolves.
// Re-placing the sell offer each time naturally rate-limits access: only one
// grant is available until the Agent explicitly reopens it by calling
// grant() again. The Requester's half of this (placing the matching buy) is
// tg/ja/public/jr/gate.js -- Stellar's DEX auto-matches standing orders
// whenever a compatible one appears, so neither side needs to coordinate
// timing; the Agent's public key just needs to be known to Requesters ahead
// of time, the same way any service's payment address would be.
//
// Env:
//   TG_ISSUER_SK      -- required: the Agent's own Stellar secret key --
//                        the account that places the sell offer (and
//                        whose trades are watched). Also the asset's own
//                        issuer by default (see TG_ASSET_ISSUER_PK).
//   TG_ASSET_CODE     -- optional, defaults to 'TGA'
//   TG_ASSET_ISSUER_PK -- optional, defaults to this account's own PK
//                        (today's only case: issuing and selling are the
//                        same account). A reseller selling real,
//                        already-acquired inventory of someone *else's*
//                        asset (ccddh.md's RTOJ -- e.g. JA3 reselling
//                        Дід Alik's own real ECHO, not a JA3-issued
//                        look-alike "ECHO") sets this to that real
//                        issuer's own PK instead -- this account still
//                        has to actually hold a sellable balance of it
//                        (a trustline + inventory, same as any other
//                        Stellar holder), manageSellOffer doesn't care
//                        who issued what it's selling.
//   TG_PRICE          -- optional, XLM per unit sold, defaults to '1'

import { Asset, BASE_FEE, Keypair, Operation, TransactionBuilder } // {{{1
from '@stellar/stellar-sdk'
import { effectsCursorNow, ensureFunded, networkPassphrase, pollForTrade, server } from '@amissine/daeh/stellar.mjs'

function assetCode () { return process.env.TG_ASSET_CODE ?? 'TGA'; } // {{{1

function assetIssuerPk (kp) { return process.env.TG_ASSET_ISSUER_PK ?? kp.publicKey(); } // {{{1

function price () { return process.env.TG_PRICE ?? '1'; } // {{{1

async function sell (kp, asset) { // {{{1
  const account = await server.loadAccount(kp.publicKey())
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.manageSellOffer({
      selling: asset, buying: Asset.native(), amount: '1', price: price(), offerId: '0',
    }))
    .setTimeout(60).build()
  tx.sign(kp)
  return server.submitTransaction(tx);
}

//async function cancelStaleOffers (kp, asset) {{{1
/** Cancels every pre-existing offer for this asset before placing a fresh
 * one, so at most one is ever live -- see db/jobs/agent/tm.js's own
 * comment for the bug this guards against (stale offers piling up across
 * interrupted rounds, each an unintended standing "grant"). */
async function cancelStaleOffers (kp, asset) {
  const { records } = await server.offers().forAccount(kp.publicKey()).call()
  const stale = records.filter(o =>
    o.selling.asset_code === asset.code && o.selling.asset_issuer === asset.issuer)
  if (stale.length === 0) return;

  const account = await server.loadAccount(kp.publicKey())
  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
  for (const offer of stale) {
    builder.addOperation(Operation.manageSellOffer({
      selling: asset, buying: Asset.native(), amount: '0', price: offer.price, offerId: offer.id,
    }))
  }
  const tx = builder.setTimeout(60).build()
  tx.sign(kp)
  await server.submitTransaction(tx)
}

//export async function grant (onLog = () => {}) {{{1
/** Opens the gate (places a fresh sell offer for 1 unit of the Agent's own
 * asset) and resolves once someone's matching trade fills it. Used to
 * also resolve with the Requester's own account, for buildPod() (now
 * retired -- see ccddh.md's "Proof of Delivery, Redefined": the Requester
 * pays the asset back unilaterally once the Job is done, instead of the
 * Agent building a clawback transaction for it to co-sign, so the Agent
 * no longer needs to know who the Requester even was). */
export async function grant (onLog = () => {}) {
  const sk = process.env.TG_ISSUER_SK
  if (!sk) throw new Error('TG_ISSUER_SK must be set (this Agents own Stellar secret key)');
  const kp = Keypair.fromSecret(sk)
  const asset = new Asset(assetCode(), assetIssuerPk(kp))

  await ensureFunded(kp)
  // Both the stream and the poll fallback below start from this same point
  // -- fetched once, before either subscribes, so neither has a gap the
  // other doesn't also cover.
  const since = await effectsCursorNow(kp.publicKey())
  const matches = effect => Number(effect.bought_amount) === Number(price()) // not a different/partial fill

  return new Promise((resolve, reject) => { // {{{2
    let settled = false
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true
      closeStream(); stopPoll();
      fn(arg);
    }
    const granted = (effect, suffix) => {
      onLog(`granted -- trade filled (bought ${effect.bought_amount} XLM for 1 ${assetCode()})${suffix}`)
      finish(resolve);
    }

    // Subscribed *before* placing the sell -- same race as
    // jr/gate.js's buyGrant() (see its comment): if a matching buy is
    // already resting on the book when the sell is placed, the trade can
    // execute synchronously as part of that submission, and a stream
    // started afterward would miss it even with cursor(since).
    const closeStream = server.effects().forAccount(kp.publicKey()).cursor(since).stream({
      onmessage: effect => {
        if (effect.type !== 'trade' || !matches(effect)) return;
        granted(effect, '');
      },
      onerror: err => finish(reject, err),
    })
    // Belt-and-braces fallback -- see pollForTrade's comment: the SSE stream
    // above has been observed, live, to silently stop delivering events.
    const stopPoll = pollForTrade(kp.publicKey(), since, matches, effect => {
      granted(effect, ' [via poll fallback]');
    })

    cancelStaleOffers(kp, asset)
      .then(() => {
        onLog(`selling 1 ${assetCode()}:${asset.issuer} for ${price()} XLM (seller ${kp.publicKey()})`)
        return sell(kp, asset);
      })
      .catch(err => finish(reject, err))
  }); // }}}2
}
