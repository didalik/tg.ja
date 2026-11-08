# ja

The "ja"-kind Toll Gate Agent/Requester: offers `echo`, `csr`, `sell`, `buyInvite` (`jobs/`), and
the Requester-side CLI tools (`jr/`) that buy them, including the local bridge (`jr/bridge.mjs`)
that drives the whole join flow for a demo visitor in one process.

See `dqad.md` and `cnj.md` (root `k2` repo) for the demo/QA process this is a part of.

## Known open question: the daily account reset can interrupt an in-flight Job

The Owner's and JA2's own Stellar accounts get recreated from scratch (`recreateAccount` --
merge into a sink, then re-fund) every time their service (re)starts, not just on a deliberate
`systemctl restart`: `ExecStartPre=` reruns on a crash-triggered `Restart=always` restart too,
the same way it would on an intentional one. This wipes whatever that account had going at the
moment -- any open sell offer, any trustline a reseller had just established, any Job genuinely
mid-relay with an already-matched Requester.

Today this is a latent risk, not something routinely observed: a demo session is short, and a
crash-triggered restart is rare. It gets materially more exposed once this runs continuously
and gets a *daily* scheduled reset (the original reasoning for resetting at all -- staying ahead
of Stellar testnet's own periodic reset, ~every 3 months, by making a fresh account a non-event
rather than a surprise) on real hardware (Pi5).

**What we do today, as an interim measure:** `tg/genesis.mjs` (root `k2` repo) runs at reset
time, resetting the whole demo/QA environment back to a known-clean slate -- every mTLS cert
except the Owner's and JA2's own revoked, every `/jobs` entry that isn't theirs retracted, any
stray offer on either of their own accounts cancelled. This is a *blunt* fix, not a graceful
one, and it's worth being explicit about the tradeoff it accepts: running it abandons everyone
who already joined, mid-Job or not -- there's no draining, no grace period, no distinction
between a Job that's about to finish and one that just started. It solves "the reset doesn't
leave stale, misleading garbage behind" without solving "the reset doesn't interrupt anyone" --
those are two different problems, and only the first one is handled so far.

**The proposed fix for the second problem, not yet built:** decouple the reset from the restart
path entirely (the same way mba's own Tosh setup already keeps `com.tosh.reset` on its own daily
schedule, separate from `com.tosh.agent`'s `KeepAlive`-driven restarts) and run it at a *known,
chosen* time instead -- e.g. 3am daily:

1. Suspend gating new Jobs (stop placing fresh sell offers) -- nothing new starts.
2. Wait for every already-gated Job to actually finish (PoP and PoD both landed). This is why
   Jobs are meant to be short-lived in the first place -- the wait is bounded by design, not by
   hoping it resolves quickly.
3. Force-stop anything that doesn't wrap up in a reasonable window, using the Job asset's own
   clawback flag (`AuthClawbackEnabledFlag`, already set on every issued asset -- see
   `reset.mjs`/`run.js`'s own `recreateAccount` call) rather than just waiting indefinitely.
4. Only then run `genesis.mjs` and the account reset.

This shrinks the exposure from "a reset can hit any in-flight Job, any time" down to "a reset
only ever happens in a window where nothing's expected to still be running" -- smaller, and
reuses a pattern already proven out elsewhere in this project. Documented here, not yet
implemented, specifically because the QA process this demo is the entry point for is expected to
run long enough that this is worth knowing about up front, not discovering mid-session.
