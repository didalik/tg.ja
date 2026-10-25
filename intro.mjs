import { put, reset, } from './lib/util.mjs' // {{{1

reset({ content: document.getElementById('content1'), })

//async function renderCatalog () {{{1
/** Fetches the one shared job catalog (unfiltered -- every assetCode,
 * not just 'ECHO') and renders one pick-one card per group of
 * genuinely-fungible entries (ccddh.md's reselling round) -- same
 * assetCode *and* the same real issuer (types.ts's
 * RegistryEntry.realIssuerPk), not merely the same assetCode the way
 * Tosh's LLM-backed chat shares 'ECHO' with Дід Alik's own plain echo
 * without being a substitute for it at all. A reseller's own entry (JA3
 * reselling Дід Alik's real ECHO) *is* a genuine substitute, so its
 * group collapses into the real issuer's own card: shown at the real
 * issuer's own baseline price/description, but linking to
 * /ja?assetCode=...&realIssuerPk=...&aud=...&description=... (no
 * issuerPk pin) -- ja.mjs resolves that, at click time, to whichever
 * group member is actually cheapest right now, same DEX-driven pick
 * entries[0] already uses. A visitor who clicks the "price 1" card can
 * genuinely end up paying JA3's lower price instead, on purpose.
 *
 * `aud` matters, not just cosmetic: calc's own entry advertises
 * aud: 'calc' (see tg/local/bin/toll_gate_calc's own TG_AUD), and
 * without passing it through, ja.mjs would request the 'echo' every
 * other entry defaults to and never match. `description` is passed
 * through too so ja.mjs can show it again without a second fetch.
 * location.origin is already http(s) -- no httpize() needed, unlike
 * ja.mjs's own derivation from a ws(s): URL. */
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

  // Entries arrive already sorted cheapest-first (server-side), so each
  // group's own first member is its cheapest -- no re-sorting needed here.
  const groups = new Map()
  for (const entry of entries) {
    const realIssuerPk = entry.realIssuerPk ?? entry.issuerPk
    const key = `${entry.assetCode ?? ''}:${realIssuerPk}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(entry)
  }

  for (const group of groups.values()) {
    // Show the real issuer's own entry (the baseline a visitor should
    // expect) when it's among what was fetched -- falls back to the
    // group's own cheapest otherwise, which shouldn't normally happen.
    const realIssuerPk = group[0].realIssuerPk ?? group[0].issuerPk
    const shown = group.find(e => e.issuerPk === realIssuerPk) ?? group[0]
    const params = new URLSearchParams({
      assetCode: shown.assetCode ?? '', realIssuerPk, smName: shown.smName,
      aud: shown.aud ?? '', description: shown.description ?? '',
    })
    const href = `/ja?${params.toString()}`
    const note = group.length > 1 ? ` -- ${group.length} sellers, cheapest wins when you connect` : ''
    put(`<div class='job-card'>
      <b>${shown.assetCode ?? '(no asset code)'}</b> -- ${shown.description ?? '(no description given)'}${note}
      <br/>price: ${shown.price ?? '?'} -- <a href='${href}'>Try this one</a>
    </div>`)
  }
}

renderCatalog().catch(e => { // {{{1
  console.error('renderCatalog FAILED', e)
  put(`<p>FAILED to load the job catalog: ${e.message}</p>`)
})

