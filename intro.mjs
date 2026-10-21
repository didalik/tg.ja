import { put, reset, } from './lib/util.mjs' // {{{1

reset({ content: document.getElementById('content1'), })

//async function renderCatalog () {{{1
/** Fetches the one shared job catalog (unfiltered -- every assetCode,
 * not just 'ECHO') and renders each entry as a pick-one card, linking to
 * /ja?issuerPk=...&assetCode=...&smName=... rather than connecting from
 * here directly. ja.mjs picks those query params up and uses them
 * as-is, skipping its own catalog discovery entirely (ccddh.md's
 * discovery-ambiguity round) -- this page is where a human browses and
 * chooses; /ja is where the chosen session actually runs. location.origin
 * is already http(s) -- no httpize() needed, unlike ja.mjs's own
 * derivation from a ws(s): URL. */
async function renderCatalog () {
  const registryUrl = `${location.origin}/catalog/registry`
  const res = await fetch(registryUrl)
  if (!res.ok) {
    put(`<p>Couldn't reach the job catalog (${registryUrl} -> ${res.status}).</p>`)
    return;
  }
  const entries = await res.json()
  if (entries.length === 0) {
    put('<p>No Jobs registered right now -- check back later.</p>')
    return;
  }
  for (const entry of entries) {
    const params = new URLSearchParams({ issuerPk: entry.issuerPk, assetCode: entry.assetCode ?? '', smName: entry.smName })
    const href = `/ja?${params.toString()}`
    put(`<div class='job-card'>
      <b>${entry.assetCode ?? '(no asset code)'}</b> -- ${entry.description ?? '(no description given)'}
      <br/>price: ${entry.price ?? '?'} -- <a href='${href}'>Try this one</a>
    </div>`)
  }
}

renderCatalog().catch(e => { // {{{1
  console.error('renderCatalog FAILED', e)
  put(`<p>FAILED to load the job catalog: ${e.message}</p>`)
})
