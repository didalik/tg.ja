// tg/ja/public/jr/stellar.mjs -- shared Stellar network plumbing for the
// Toll Gate's gate mechanism: tg/ja/gate.js (the seller/gatekeeper,
// reaching in from the root k2 repo -- the Agent isn't meant to be
// independently cloneable, so this lives here once rather than as a
// second copy) and tg/ja/public/jr/gate.js (the buyer, alongside it).
//
// Env:
//   TG_STELLAR_NETWORK -- optional, 'testnet' (default) or 'public' --
//                         selects which Stellar network/Horizon instance
//                         this Agent/Requester talks to. Local and qa BITs
//                         run against testnet; prod moves to 'public'
//                         (mainnet) once the toll-gate flow is proven there.

import { Horizon, Networks } from '@stellar/stellar-sdk'

const NETWORKS = {
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    passphrase: Networks.TESTNET,
    friendbotUrl: 'https://friendbot.stellar.org',
  },
  public: {
    horizonUrl: 'https://horizon.stellar.org',
    passphrase: Networks.PUBLIC,
    friendbotUrl: null, // mainnet has no friendbot -- accounts must be funded for real
  },
}

const networkName = process.env.TG_STELLAR_NETWORK ?? 'testnet'
const network = NETWORKS[networkName]
if (!network) throw new Error(`unknown TG_STELLAR_NETWORK '${networkName}' -- expected 'testnet' or 'public'`);

export const networkPassphrase = network.passphrase
export const server = new Horizon.Server(network.horizonUrl)

export async function ensureFunded (kp) { // {{{1
  try {
    await server.loadAccount(kp.publicKey())
  } catch (err) {
    if (err?.response?.status !== 404) throw err;
    if (!network.friendbotUrl) {
      throw new Error(`account ${kp.publicKey()} not found on ${networkName}, which has no friendbot -- fund it manually`);
    }
    const res = await fetch(`${network.friendbotUrl}?addr=${kp.publicKey()}`)
    if (!res.ok) throw new Error('friendbot funding failed: ' + await res.text());
  }
}

/** The paging_token of the most recent existing effect on `pk`, or '0' if
 * there are none yet -- the REST equivalent of a stream's cursor('now'):
 * pollForTrade only ever looks at effects strictly after this point. {{{1 */
export async function effectsCursorNow (pk) {
  const { records } = await server.effects().forAccount(pk).order('desc').limit(1).call()
  return records[0]?.paging_token ?? '0';
}

/** Fallback for grant()/buyGrant(): Horizon's effects SSE stream has been
 * observed, live, to silently stop delivering events -- a real trade
 * executed and was visible via Horizon's own REST API, but neither the SDK's
 * .stream() nor even a raw `curl -N` SSE subscription to the same endpoint
 * ever received it. Polls the same account's effects over plain REST as a
 * belt-and-braces fallback, so a dead/stalled stream can't hang a grant
 * forever. Call stop() once whichever side (this or the stream) wins to
 * cancel the other. {{{1 */
export function pollForTrade (pk, since, matches, onFound, intervalMs = 5000) {
  let stopped = false
  let cursor = since
  ;(async () => {
    while (!stopped) {
      await new Promise(resolve => setTimeout(resolve, intervalMs))
      if (stopped) return;
      let records
      try {
        ;({ records } = await server.effects().forAccount(pk).cursor(cursor).order('asc').limit(50).call())
      } catch {
        continue; // transient REST hiccup -- just retry next tick
      }
      for (const effect of records) {
        cursor = effect.paging_token
        if (effect.type === 'trade' && matches(effect)) {
          if (!stopped) onFound(effect);
          return;
        }
      }
    }
  })()
  return () => { stopped = true; };
}
