import { put, reset, } from './lib/util.mjs' // {{{1

reset({ content: document.getElementById('content1'), })

// ja.mjs's own flow is generic on purpose -- one gate trade, then a plain
// chat-style WS exchange (type a line, get a line back). csr and peer
// both need something structurally different instead: csr expects a real
// {csr, network, email} JSON payload and only resolves after a human (or
// an invite) approves it, not an instant reply; peer expects an SSH
// keypair generated and exchanged server-side, not a typed message.
// Pointing a browser visitor at either through this generic UI doesn't
// just fail cleanly -- csr still runs (and pays for) a real gate trade
// first, since that part genuinely is generic, then the chat text sent
// afterward fails CSR verification with nothing to show for it (caught
// live: a real visitor polluted the Stellar side twice this way). csr
// now links to the local bridge instead (dqad.md's step 2) -- a plain
// target='_blank' link, a top-level navigation into a new tab, never
// subject to CORS the way a cross-origin fetch would be; an unreachable
// bridge just shows the browser's own ordinary connection-failed page
// in that tab, nothing for this page itself to detect. peer stays hidden until it gets the
// same treatment (or its own dedicated flow) -- still usable via
// jr/request-peer.mjs. sell joins it here too -- its own
// {assetCode, requesterPk} structured payload (tg/ja/jobs/sell/sell.mjs)
// is exactly this same mismatch, caught before it ever reached a real
// visitor this time: run.js's own postThisJob() posts every offered Job
// to /jobs regardless, so toll_gate_sell.service showing up here was
// never actually guarded against until now. Still usable via
// jr/sell.mjs.
// buyInvite joins them pre-emptively this time (dqad.md's step 5,
// tg/ja/jobs/buyinvite/buyinvite.mjs): same {applicantPk, expiry}
// structured-payload mismatch, caught before deploy rather than after,
// this time -- both Owner and JA2 will post their own buyInvite entry
// to /jobs the moment their own services start.
const BROWSER_UNSUPPORTED = new Set(['PEER', 'SELL', 'buyInvite'])

// The local bridge's own default port (tg/ja/public/jr/bridge.mjs's own
// BRIDGE_PORT default) -- http, not https: localhost is treated as a
// secure context regardless of scheme, same reasoning dqad.md's own
// step 2 already gives, so there's no TLS cert to juggle here either.
const BRIDGE_URL = 'http://localhost:8099/'

//async function renderCatalog () {{{1
/** Fetches the KoT Jobs list (cnj.md -- tg/ws/src/jobs.ts, which replaced
 * catalog's own RegistryEntry/realIssuerPk scheme, ccddh.md's "retiring
 * the registry" round) and renders one card per Job (skipping
 * BROWSER_UNSUPPORTED ones -- see its own comment), linking to
 * /ja?assetCode=<name>&issuerPk=<issuerPk>&description=<desc>. No price
 * shown any more -- it lives on the Stellar DEX's own order book, where
 * it can't go stale, and only matters at trade time, not browse time.
 * No resale grouping needed either: a reseller never gets its own /jobs
 * entry at all (it's selling the exact same fungible asset the real
 * issuer already lists, not a distinct Job), so Stellar's own DEX
 * already picks up whichever account is cheapest right now the moment a
 * visitor actually clicks through -- nothing here needs to know a
 * reseller exists. location.origin is already http(s) -- no httpize()
 * needed, unlike ja.mjs's own derivation from a ws(s): URL. */
async function renderCatalog () {
  const jobsUrl = `${location.origin}/jobs`
  const res = await fetch(jobsUrl)
  if (!res.ok) {
    put(`<p>Couldn't reach the Jobs list (${jobsUrl} -> ${res.status}).</p>`)
    return;
  }
  const jobs = (await res.json()).filter(j => !BROWSER_UNSUPPORTED.has(j.name))
  if (jobs.length === 0) {
    put('<p>No Jobs posted right now -- check back later.</p>')
    return;
  }

  for (const j of jobs) {
    // csr: a plain link to the local bridge, opened in a new tab -- see
    // this file's own header comment above for why this sidesteps CORS
    // entirely instead of needing it handled. BRIDGE_URL is the one
    // thing a demo visitor's own bridge is expected to already be
    // listening on by default (tg/ja/public/jr/bridge.mjs's own
    // BRIDGE_PORT, unset by anyone who hasn't deliberately overridden
    // it) -- there's no way for this page to discover a different port
    // a specific visitor's own bridge might be using instead.
    const [href, linkAttrs] = j.name === 'CSR'
      ? [BRIDGE_URL, " target='_blank'"]
      : [`/ja?${new URLSearchParams({ assetCode: j.name, issuerPk: j.issuerPk, description: j.desc ?? '' })}`, '']
    put(`<div class='job-card'>
      <b>${j.name}</b> -- ${j.desc ?? '(no description given)'}
      <br/><a href='${href}'${linkAttrs}>Try this one</a>
    </div>`)
  }
}

renderCatalog().catch(e => { // {{{1
  console.error('renderCatalog FAILED', e)
  put(`<p>FAILED to load the job catalog: ${e.message}</p>`)
})

