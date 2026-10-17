// tg/ja/public/jr/gate-p.mjs -- the Requester's half of sh's 'peer' gate {{{1
// mechanism (tg/sh/gate.js is E's own half, still Agent-side infrastructure
// -- only this half moved here, alongside request-peer.mjs, so both
// survive tg/ja/public eventually becoming its own public repo -- ccddh.md):
// places a matching buy for E's 'peer' job asset and resolves once it
// fills. Adapted from ./gate.js's own buyGrant -- simplified, no PoD (see
// tg/sh/gate.js's own header for why).
//
// Env:
//   SH_ISSUER_PK   -- required: E's own Stellar public key
//   SH_ASSET_CODE  -- optional, defaults to 'TGA' -- must match E's
//   SH_PRICE       -- optional, defaults to '1' -- must match E's
//   SH_GRANT_TIMEOUT_MS -- optional: if the buy offer doesn't fill within
//                        this many ms, cancel it and give up

import { Asset, BASE_FEE, Keypair, Operation, TransactionBuilder } // {{{1
from '@stellar/stellar-sdk'
import { effectsCursorNow, ensureFunded, networkPassphrase, pollForTrade, server }
from '../../../../daeh/lib/stellar.mjs'

function assetCode () { return process.env.SH_ASSET_CODE ?? 'TGA'; } // {{{1

function price () { return process.env.SH_PRICE ?? '1'; } // {{{1

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

async function cancelBuyOffer (kp, asset) { // {{{1
  const { records } = await server.offers().forAccount(kp.publicKey()).call()
  const mine = records.filter(o =>
    o.buying.asset_code === asset.code && o.buying.asset_issuer === asset.issuer)
  if (mine.length === 0) return;

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

//export async function buyGrant (onLog, grantTimeoutMs) {{{1
/** Places a standing buy offer for E's gate asset and resolves, once it's
 * filled, with the Stellar keypair used -- this same keypair also signs
 * the WS Match/Relay handshake (see ccddh.md round 20's MRT design: one
 * stable keypair serves both purposes for sh's agents). */
export async function buyGrant (
  onLog = () => {},
  grantTimeoutMs = process.env.SH_GRANT_TIMEOUT_MS ? Number(process.env.SH_GRANT_TIMEOUT_MS)
                   : undefined
) {
  const issuerPk = process.env.SH_ISSUER_PK // {{{2
  if (!issuerPk) throw new Error('SH_ISSUER_PK must be set (Es own Stellar public key)');
  const kp = process.env.SH_P_SK ? Keypair.fromSecret(process.env.SH_P_SK) : Keypair.random()
  const asset = new Asset(assetCode(), issuerPk)

  await ensureFunded(kp)
  onLog(`trusting ${assetCode()}:${issuerPk}`)
  await trust(kp, asset)

  const since = await effectsCursorNow(kp.publicKey())

  return new Promise((resolve, reject) => { // {{{2
    let settled = false
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true
      closeStream(); stopPoll(); clearTimeout(timeoutTimer)
      fn(arg);
    }

    const closeStream = server.effects().forAccount(kp.publicKey()).cursor(since).stream({
      onmessage: effect => {
        if (effect.type !== 'trade') return;
        onLog('grant confirmed -- trade filled')
        finish(resolve, kp);
      },
      onerror: err => finish(reject, err),
    })
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
