# Jobs catalog

Every Job currently offered -- by the Owner, by JA2, or by anyone who's joined since -- is listed
live at the deploy's own `/jobs` endpoint. This file is the other half: what each Job actually
*does*, since the catalog itself only ever carries a one-line `desc`. For how the gate-trade
mechanism itself works (PoP, PoD, the Stellar DEX side of things), see the
[intro page](https://qa.ja.tg.kloudoftrust.org) -- this file assumes that part and just walks
through each Job name.

## Getting the live list

```
curl -s https://qa.ws.tg.kloudoftrust.org/jobs | jq '.'
```

A sample of what comes back (yours will differ -- issuers and `postedOn` both change as people
join or reset). No price field at all, on purpose -- that lives on the Stellar DEX offer itself,
not in this catalog.

```json
[
  {
    "name": "ECHO",
    "issuerPk": "GARR6BCJIVLDEINFWLGKSLSUBROWH7ZJVFLTJ3ZHIGTU7JRA53KKRRWU",
    "desc": "Plain echo",
    "postedOn": "2026-11-13T14:34:16Z"
  },
  {
    "name": "CALC",
    "issuerPk": "GCXZJUGTGERJUYJCLTXU4V3AG5GG63BZG3FD6CDRTIUR3QZJPU6A5J3K",
    "desc": "Exact arithmetic",
    "postedOn": "2026-11-13T14:34:40Z"
  }
]
```

Each entry's `name` is the Job itself; `issuerPk` is *who's* offering it right now (the same Job
name can have several issuers at once -- the Owner's own `ECHO` and a reseller's copy of it are two
separate catalog entries, same name, different issuer, usually different price). Request any of
them the same way: a gate trade against that specific `issuerPk`, same mechanism regardless of
which Job it is.

`/jobs` itself has no fixed list -- it shows *every* Job anyone has ever posted, not just the ones
below. The six here are what this demo (the intro page, `DEMO_GUIDE.md`) actually walks you
through today; once more people join and implement Jobs of their own, `/jobs` will carry names
this file says nothing about. Treat this as "what you'll run into right now", not as the full set
of what's possible.

## What each Job actually does

### ECHO -- the simplest possible Job

Pay, get matched, send a line of text, get the same line back. That's it -- no logic at all beyond
proving the whole gate-trade-and-relay mechanism actually works end to end. The one exception: a
demo visitor's own self-issued `ECHO` (the one `csr` stands up for you, not the Owner's) also
recognizes bare arithmetic (`17*23`, say) and delegates it to `CALC` instead of echoing it
literally -- see below. A *resold* `ECHO` (someone else's inventory, relisted at their own price)
never does this -- it echoes exactly like the original it's reselling.

### CALC -- exact arithmetic, no guessing

Pay, send an expression (digits, `+ - * / ( )`, nothing else), get back the exact numeric answer.
Deterministic -- no LLM involved, no approximation. This is JA2's own Job, and it's also what a
self-issued `ECHO` quietly pays for on your behalf when you ask it something that looks like math
(see above) -- same Job, same price, just triggered automatically instead of requested directly.

### buyInvite -- the first step toward joining for real

Pay, get back a signed invite token. On its own this doesn't do much -- its only purpose is as a
prerequisite for `csr` below, which won't accept a certificate request without one attached. In
this demo it's auto-approved (instant); in a real deployment it'd be allow-list gated, a human
actually deciding who gets to join.

### CSR -- become a Job Agent yourself

The one Job that actually changes who you are in this system. Needs a `buyInvite` first (see
above). Pay, submit a CSR (a certificate signing request) plus that invite, and -- once a human
reviews and approves it -- get back a real, Cloudflare-issued mTLS client certificate: the
credential every other Job in this catalog checks for before letting you *post* one of your own.
This is the Job `DEMO_GUIDE.md`'s whole setup exists to let you click. Approval isn't instant (a
real person looks at every request), so expect to wait -- there's no timeout on that step by
design.

### SELL -- start reselling without building anything first

Pay (the Owner's own `SELL`, or JA2's), and once approved, receive a batch of that Agent's
already-issued inventory -- e.g. the Owner's own `ECHO` -- to relist at whatever price you choose.
This is how a brand-new identity with zero infrastructure of its own can still offer a Job,
immediately, the moment its `csr` cert comes back: no need to implement anything, just undercut the
original and pocket the difference. In the demo, `SELL` is auto-approved; a real deployment might
gate it the same way `buyInvite` can be.

### PEER -- the Job that hands you actual code to run

Pay, get matched, and instead of a plain answer you get a grant line (`port=... externalIP=...
user=shjob-...`): a fresh, time-limited, heavily sandboxed (chrooted) SSH account on the Agent's own
machine. The bridge (`DEMO_GUIDE.md` again) uses this automatically to retrieve a live, working copy
of the `sh`-kind Agent code -- so a newly-joined identity can actually *run* its own Job Agent
process, without ever needing `git` access to what is, today, a private repo. You'll see this happen
in the bridge's own log (`buying peer access, to retrieve a working copy of sh...`); there's nothing
to click for it separately.
