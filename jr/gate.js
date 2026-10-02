// tg/ja/public/jr/gate.js -- the Requester's half of the Toll Gate's gate {{{1
// mechanism (see tg/ja/gate.js for the Agent's half and the full
// mechanism). Establishes trust to the Agent's issued asset and places a
// matching buy offer -- Stellar's DEX auto-matches standing orders
// whenever a compatible one appears, so this doesn't need to coordinate
// timing with the Agent at all: place the order and wait, even if the
// Agent's sell isn't live yet.
//
// Env:
//   TG_ISSUER_PK       -- required: the Agent's own Stellar public key. This
//                        is published/known ahead of time, the same way any
//                        service's payment address would be -- it can't be
//                        discovered via the WS handshake, since the Agent
//                        doesn't even connect to tg/ws until after its own
//                        gate opens.
//   TG_ASSET_CODE      -- optional, defaults to 'TGA' -- must match the Agent's
//   TG_PRICE           -- optional, defaults to '1' -- must match the Agent's
//   TG_JR_SK    -- optional: reuse a specific Stellar identity instead
//                        of generating (and funding) a fresh one each run
//   TG_GRANT_TIMEOUT_MS -- optional: if the buy offer doesn't fill within
//                        this many ms, cancel it (see cancelBuyOffer) and
//                        give up -- unset (the default) waits forever,
//                        same as db's original tm.js always has.

import { Asset, BASE_FEE, Keypair, Operation, TransactionBuilder } // {{{1
from '@stellar/stellar-sdk'
import { effectsCursorNow, ensureFunded, networkPassphrase, pollForTrade, server }
from '../../../../daeh/lib/stellar.mjs'

function assetCode () { return process.env.TG_ASSET_CODE ?? 'TGA'; } // {{{1

function price () { return process.env.TG_PRICE ?? '1'; } // {{{1

async function trust (kp, asset) { // {{{1
  const account = await server.loadAccount(kp.publicKey())
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(60).build()
  tx.sign(kp)
  return server.submitTransaction(tx);
}

async function buy (kp, asset) { // {{{1
  const account = await server.loadAccount(kp.publicKey())
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.manageBuyOffer({
      selling: Asset.native(), buying: asset, buyAmount: '1', price: price(), offerId: '0',
    }))
    .setTimeout(60).build()
  tx.sign(kp)
  return server.submitTransaction(tx);
}

//async function cancelBuyOffer (kp, asset) {{{1
/** Cancels this account's still-pending (unfilled) buy offer(s) for `asset`
 * -- the mirror image of tg/ja/gate.js's cancelStaleOffers, but for the
 * Requester's own offer: if nobody's granting this, don't leave it resting
 * on the DEX forever either. Looks the offer up by querying the account
 * directly (same technique cancelStaleOffers uses) rather than trying to
 * extract an offer id out of the submission result's XDR -- simpler, and
 * doesn't depend on that shape at all. */
async function cancelBuyOffer (kp, asset) {
  const { records } = await server.offers().forAccount(kp.publicKey()).call()
  const mine = records.filter(o =>
    o.buying.asset_code === asset.code && o.buying.asset_issuer === asset.issuer)
  if (mine.length === 0) return; // already filled (or never actually placed) by now

  const account = await server.loadAccount(kp.publicKey())
  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
  for (const offer of mine) {
    builder.addOperation(Operation.manageBuyOffer({
      selling: Asset.native(), buying: asset, buyAmount: '0', price: offer.price, offerId: offer.id,
    }))
  }
  const tx = builder.setTimeout(60).build()
  tx.sign(kp)
  await server.submitTransaction(tx)
}

//export async function submitPod (xdr, kp) {{{1
/** Co-signs (with this Requester's own key) the Proof of Delivery XDR the
 * Agent relayed at match time, and submits it -- see tg/ja/gate.js's
 * buildPod for the Agent's half and ccddh.md's PoP/PoD design note. The
 * transaction's own source is this Requester's account (see buildPod), so
 * this signature is what actually lets it go through; the clawback
 * operation itself only needed the Issuer's, already on the XDR. Returns
 * the submitted transaction's hash -- the PoD's own on-chain id. */
export async function submitPod (xdr, kp) {
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase)
  tx.sign(kp)
  const result = await server.submitTransaction(tx)
  return result.hash;
}

//export async function buyGrant {{{1
/** Places a standing buy offer for the Agent's gate asset and resolves,
 * once it's filled, with the Stellar keypair used for the trade -- the
 * Requester needs it again later, to co-sign the PoD (see submitPod). If
 * TG_GRANT_TIMEOUT_MS (or the grantTimeoutMs argument) is set and the
 * offer hasn't filled within that window, cancels it and rejects instead
 * of waiting forever -- an AbortController drives the timeout, the same
 * pattern daeh's matchTimeoutMs/relayTimeoutMs use. */
export async function buyGrant (
  onLog = () => {}, 
  grantTimeoutMs = process.env.TG_GRANT_TIMEOUT_MS ? Number(process.env.TG_GRANT_TIMEOUT_MS)
                   : undefined
) {
  const issuerPk = process.env.TG_ISSUER_PK // {{{2
  if (!issuerPk) throw new Error('TG_ISSUER_PK must be set (the Agents own Stellar public key)');
  const kp = process.env.TG_JR_SK ? Keypair.fromSecret(process.env.TG_JR_SK) : Keypair.random()
  const asset = new Asset(assetCode(), issuerPk)

  await ensureFunded(kp)
  onLog(`trusting ${assetCode()}:${issuerPk}`)
  await trust(kp, asset)

  // Both the stream and the poll fallback below start from this same point
  // -- fetched once, before either subscribes, so neither has a gap the
  // other doesn't also cover.
  const since = await effectsCursorNow(kp.publicKey())

  return new Promise((resolve, reject) => { // {{{2
    let settled = false
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true
      closeStream(); stopPoll(); clearTimeout(timeoutTimer)
      fn(arg);
    }

    // Subscribed *before* placing the buy -- if the Agent's sell is already
    // live, the trade can execute synchronously as part of the buy
    // submission itself. A stream started afterward (even with
    // cursor(since)) would then be subscribing to a point in time *after*
    // the trade already happened, and would miss it -- confirmed by
    // testing: the trade visibly executed (the Agent's own side detected
    // it), but this side's buyGrant() never resolved.
    const closeStream = server.effects().forAccount(kp.publicKey()).cursor(since).stream({
      onmessage: effect => {
        // This account only ever does this one trade -- any 'trade' effect
        // on it is unambiguously this offer filling, no amount check needed.
        if (effect.type !== 'trade') return;
        onLog('grant confirmed -- trade filled')
        finish(resolve, kp);
      },
      onerror: err => finish(reject, err),
    })
    // Belt-and-braces fallback -- see pollForTrade's comment: the SSE stream
    // above has been observed, live, to silently stop delivering events
    // (the very bug the comment above was already written to guard against,
    // just via a different mechanism -- this covers it regardless of cause).
    const stopPoll = pollForTrade(kp.publicKey(), since, () => true, () => {
      onLog('grant confirmed -- trade filled [via poll fallback]')
      finish(resolve, kp);
    })

    const timeoutTimer = grantTimeoutMs == null ? undefined : setTimeout(() => {
      onLog(`no fill within ${grantTimeoutMs}ms -- cancelling the buy offer`)
      cancelBuyOffer(kp, asset)
        .catch(err => console.error('cancelBuyOffer failed', err))
        .finally(() => finish(reject, new Error(`buyGrant(): no fill within ${grantTimeoutMs}ms`)))
    }, grantTimeoutMs)

    onLog(`buying 1 ${assetCode()} for ${price()} XLM (${kp.publicKey()})`)
    buy(kp, asset).catch(err => finish(reject, err))
  }); // }}}2
}
