import { put, reset, } from './lib/util.mjs' // {{{1

// Same local wrapper ja.mjs's own `out` already has (tg/ja/public/lib/
// util.mjs's own put() stays the simpler, no-scroll copy on purpose --
// see ja.mjs's own header note) -- the catalog renders one card per Job
// in a loop below, which can grow past the viewport on a longer list,
// same reasoning either page has for not leaving new content to scroll
// to manually.
const out = m => {
  put(m)
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
}

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

// Guided order (ccddh.md's "open the tabs in an orderly manner" round):
// ECHO is always immediately try-able; CALC unlocks once ECHO's own
// chat-session.mjs has actually ended with a PoD (completionKey:
// 'echo'/'calc', see that file's own comment); CSR unlocks once CALC
// has. localStorage, not a server-side flag -- echo/calc/intro are all
// the same origin, so the Job's own tab (a different tab from this
// catalog) can just write a key this tab picks up, no new endpoint
// needed the way bridge.mjs's own cross-origin own-echo/owner-echo case
// does (see jr/bridge.mjs's own notifyUrl/mark-done). {{{1
const CATALOG_ORDER = ['ECHO', 'CALC', 'CSR']
const UNLOCKED_BY = { ECHO: null, CALC: 'echo', CSR: 'calc' }
for (const key of ['echo', 'calc']) {
  try { localStorage.removeItem(`kot_done_${key}`) } catch {}
}

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
    out(`<p>Couldn't reach the Jobs list (${jobsUrl} -> ${res.status}).</p>`)
    return;
  }
  const jobs = (await res.json()).filter(j => !BROWSER_UNSUPPORTED.has(j.name))
  if (jobs.length === 0) {
    out('<p>No Jobs posted right now -- check back later.</p>')
    return;
  }
  // CATALOG_ORDER first, in that order; anything else (there isn't
  // anything else today) keeps its own relative /jobs order, appended
  // after.
  jobs.sort((a, b) => {
    const ia = CATALOG_ORDER.indexOf(a.name), ib = CATALOG_ORDER.indexOf(b.name)
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  })

  for (const j of jobs) {
    // Every link opens in its own tab, always -- not just csr's own
    // (ccddh.md's "a dedicated page per test case" round): this page's
    // own JS keeps running and polling nothing, so there's no pagehide-
    // triggered cleanup risk here the way bridge.mjs's own links had,
    // but trying more than one Job at once (echo in one tab, calc in
    // another) only works at all if neither navigation ever replaces
    // this catalog page out from under the other.
    //
    // csr: a plain link to the local bridge -- see this file's own
    // header comment above for why this sidesteps CORS entirely instead
    // of needing it handled. BRIDGE_URL is the one thing a demo
    // visitor's own bridge is expected to already be listening on by
    // default (tg/ja/public/jr/bridge.mjs's own BRIDGE_PORT, unset by
    // anyone who hasn't deliberately overridden it) -- there's no way
    // for this page to discover a different port a specific visitor's
    // own bridge might be using instead.
    //
    // Every other Job now gets its own dedicated page (/echo, /calc, ...
    // -- ccddh.md's own round) instead of one shared /ja?assetCode=,
    // with just ?issuerPk=&description= left to pass through -- which
    // asset this is is now the page's own, not a query param.
    const href = j.name === 'CSR'
      ? BRIDGE_URL
      : `/${j.name.toLowerCase()}?${new URLSearchParams({ issuerPk: j.issuerPk, description: j.desc ?? '' })}`
    const unlockedBy = UNLOCKED_BY[j.name] // undefined (not one of the 3 guided ones) same as null -- always unlocked
    const locked = unlockedBy && !isDone(unlockedBy)
    out(`<div class='job-card'>
      <b>${j.name}</b> -- ${j.desc ?? '(no description given)'}
      <br/><span id='link-${j.name}'>${linkMarkup(href, locked, unlockedBy)}</span>
    </div>`)
  }

  // Re-checked on focus/visibilitychange (the visitor switching back from
  // the Job tab they just finished) and on 'storage' (fires in this tab
  // the moment *another* same-origin tab writes the key -- it never
  // fires in the tab that wrote it, which is why focus/visibilitychange
  // stays as the backup, not the only path). Idempotent: unlocking an
  // already-unlocked card is just re-rendering the same markup.
  for (const j of jobs) {
    const unlockedBy = UNLOCKED_BY[j.name]
    if (!unlockedBy) continue;
    const el = document.getElementById(`link-${j.name}`)
    if (!el) continue;
    const check = () => {
      if (!isDone(unlockedBy)) return;
      const href = j.name === 'CSR'
        ? BRIDGE_URL
        : `/${j.name.toLowerCase()}?${new URLSearchParams({ issuerPk: j.issuerPk, description: j.desc ?? '' })}`
      el.innerHTML = linkMarkup(href, false, unlockedBy)
    }
    window.addEventListener('storage', check)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
  }
}

//function isDone (key) {{{1
/** key is one of UNLOCKED_BY's own values ('echo'/'calc') -- see
 * chat-session.mjs's own completionKey, the only writer of this. */
function isDone (key) {
  try { return localStorage.getItem(`kot_done_${key}`) === '1'; } catch { return false; }
}

//function linkMarkup (href, locked, unlockedBy) {{{1
/** The live link once unlocked, or a plain, unclickable placeholder (not
 * a disabled <a> -- browsers render that identically to an enabled one
 * save for the cursor, which a demo visitor skimming the page could
 * easily miss) naming what to try first, while locked. */
function linkMarkup (href, locked, unlockedBy) {
  return locked
    ? `<span style='opacity:.5'>Try this one (try ${unlockedBy.toUpperCase()} first)</span>`
    : `<a href='${href}' target='_blank'>Try this one</a>`;
}

renderCatalog().catch(e => { // {{{1
  console.error('renderCatalog FAILED', e)
  out(`<p>FAILED to load the job catalog: ${e.message}</p>`)
})

