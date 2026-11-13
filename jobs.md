# Jobs catalog

Every Job currently offered -- by the Owner, by JA2, or by anyone who's joined since -- is listed
live at the deploy's own `/jobs` endpoint. This file is the other half: what each Job actually
*does*, since the catalog itself only ever carries a one-line `desc`.

Every Job here works the same underlying way: a Requester pays for it with a Stellar DEX trade
against the Agent's own asset. That trade *is* the receipt -- a public, timestamped Proof of
Purchase (PoP), produced as a side effect of the trade itself, no escrow or platform needed. Once
the Job's done, the Requester pays the same asset straight back: an ordinary payment that's itself
Proof of Delivery (PoD). This file assumes that mechanism and just walks through each Job name.

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
    "name": "CALC",
    "issuerPk": "GCXZJUGTGERJUYJCLTXU4V3AG5GG63BZG3FD6CDRTIUR3QZJPU6A5J3K",
    "desc": "Exact arithmetic",
    "postedOn": "2026-11-13T14:34:40Z"
  },
  {
    "name": "CSR",
    "issuerPk": "GARR6BCJIVLDEINFWLGKSLSUBROWH7ZJVFLTJ3ZHIGTU7JRA53KKRRWU",
    "desc": "Request a Cloudflare mTLS cert to become a Job Agent/Issuer",
    "postedOn": "2026-11-13T14:34:16Z"
  },
  {
    "name": "ECHO",
    "issuerPk": "GARR6BCJIVLDEINFWLGKSLSUBROWH7ZJVFLTJ3ZHIGTU7JRA53KKRRWU",
    "desc": "Plain echo",
    "postedOn": "2026-11-13T14:34:16Z"
  },
  {
    "name": "PEER",
    "issuerPk": "GARR6BCJIVLDEINFWLGKSLSUBROWH7ZJVFLTJ3ZHIGTU7JRA53KKRRWU",
    "desc": "A fresh, jailed SSH account",
    "postedOn": "2026-11-13T14:50:51Z"
  },
  {
    "name": "SELL",
    "issuerPk": "GARR6BCJIVLDEINFWLGKSLSUBROWH7ZJVFLTJ3ZHIGTU7JRA53KKRRWU",
    "desc": "Apply to resell one of the Owners own Jobs (demo: auto-approved)",
    "postedOn": "2026-11-13T14:34:16Z"
  },
  {
    "name": "SELL",
    "issuerPk": "GCXZJUGTGERJUYJCLTXU4V3AG5GG63BZG3FD6CDRTIUR3QZJPU6A5J3K",
    "desc": "Apply to resell one of this JIs own Jobs",
    "postedOn": "2026-11-13T14:34:40Z"
  },
  {
    "name": "buyInvite",
    "issuerPk": "GARR6BCJIVLDEINFWLGKSLSUBROWH7ZJVFLTJ3ZHIGTU7JRA53KKRRWU",
    "desc": "Owner: approve a buyinvite request (allow-list gated)",
    "postedOn": "2026-11-13T14:34:16Z"
  },
  {
    "name": "buyInvite",
    "issuerPk": "GCXZJUGTGERJUYJCLTXU4V3AG5GG63BZG3FD6CDRTIUR3QZJPU6A5J3K",
    "desc": "Get a signed invite (auto-approved in demo mode)",
    "postedOn": "2026-11-13T14:34:40Z"
  }
]
```

Each entry's `name` is the Job itself; `issuerPk` is *who's* offering it right now (the same Job
name can have several issuers at once -- the Owner's own `ECHO` and a reseller's copy of it are two
separate catalog entries, same name, different issuer, usually different price). Request any of
them the same way: a gate trade against that specific `issuerPk`, same mechanism regardless of
which Job it is.

`/jobs` itself has no fixed list -- it shows *every* Job anyone has ever posted. The eight entries
above (six distinct Job names -- `SELL` and `buyInvite` each have two issuers right now) are what's
out of the box today; once more people join and implement Jobs of their own, `/jobs` will carry
names this file says nothing about. Treat the descriptions below as "what exists right now", not as
the full set of what's possible.

## What each Job actually does

### ECHO -- the simplest possible Job

Pay, get matched, send a line of text, get the same line back. That's it -- no logic at all beyond
proving the whole gate-trade-and-relay mechanism actually works end to end. The one exception: a
self-issued `ECHO` (one `csr` lets any new Job Agent stand up for themselves, distinct from the
Owner's own) also recognizes bare arithmetic (`17*23`, say) and delegates it to `CALC` instead of
echoing it literally -- see below. A *resold* `ECHO` (someone else's inventory, relisted at their
own price) never does this -- it echoes exactly like the original it's reselling.

### CALC -- exact arithmetic, no guessing

Pay, send an expression (digits, `+ - * / ( )`, nothing else), get back the exact numeric answer.
Deterministic -- no LLM involved, no approximation. This is JA2's own Job, and it's also what a
self-issued `ECHO` quietly pays for on your behalf when you ask it something that looks like math
(see above) -- same Job, same price, just triggered automatically instead of requested directly.

### buyInvite -- the first step toward joining for real

Pay, get back a signed invite token. On its own this doesn't do much -- its only purpose is as a
prerequisite for `csr` below, which won't accept a certificate request without one attached. Right
now it's auto-approved (instant); a real deployment might gate it behind an allow-list instead, a
human actually deciding who gets to join.

### CSR -- become a Job Agent yourself

The one Job that actually changes who you are in this system. Needs a `buyInvite` first (see
above). Pay, submit a CSR (a certificate signing request) plus that invite, and -- once a human
reviews and approves it -- get back a real, Cloudflare-issued mTLS client certificate: the
credential every other Job in this catalog checks for before letting you *post* one of your own.
Approval isn't instant (a real person looks at every request), so expect to wait -- there's no
timeout on that step by design.

### SELL -- start reselling without building anything first

Pay (the Owner's own `SELL`, or JA2's), and once approved, receive a batch of that Agent's
already-issued inventory -- e.g. the Owner's own `ECHO` -- to relist at whatever price you choose.
This is how a brand-new identity with zero infrastructure of its own can still offer a Job,
immediately, the moment its `csr` cert comes back: no need to implement anything, just undercut the
original and pocket the difference. Right now `SELL` is auto-approved; a real deployment might gate
it the same way `buyInvite` can be.

### PEER -- the Job that hands you actual code to run

Pay, get matched, and instead of a plain answer you get a grant line (`port=... externalIP=...
user=shjob-...`): a fresh, time-limited, heavily sandboxed (chrooted) SSH account on the Agent's own
machine. Retrieving a live, working copy of code to actually run as your own Job Agent from that
account is the whole point -- so a newly-joined identity can offer Jobs of its own without ever
needing `git` access to a private repo.
