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
// live: a real visitor polluted the Stellar side twice this way). Hidden
// from the list until/unless they get their own dedicated browser flow --
// still real, buyable Jobs for anyone who already knows to use the
// Node-side jr/csr.mjs or jr/request-peer.mjs instead.
const BROWSER_UNSUPPORTED = new Set(['CSR', 'PEER'])

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
    const params = new URLSearchParams({ assetCode: j.name, issuerPk: j.issuerPk, description: j.desc ?? '' })
    const href = `/ja?${params.toString()}`
    put(`<div class='job-card'>
      <b>${j.name}</b> -- ${j.desc ?? '(no description given)'}
      <br/><a href='${href}'>Try this one</a>
    </div>`)
  }
}

renderCatalog().catch(e => { // {{{1
  console.error('renderCatalog FAILED', e)
  put(`<p>FAILED to load the job catalog: ${e.message}</p>`)
})

