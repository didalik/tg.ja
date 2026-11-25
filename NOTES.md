# ja

The "ja"-kind Toll Gate Agent/Requester: offers `echo`, `csr`, `sell`, `buyInvite` (`jobs/`), and
the Requester-side CLI tools (`jr/`) that buy them, including the local bridge (`jr/bridge.mjs`)
that drives the whole join flow for a demo visitor in one process.

See `DEMO_GUIDE.md` for how to join, and `jobs.md` for what every Job in the catalog actually does.

## Known issue: Chrome on Android can't open the WebSocket match

The gate trade fills fine, but the session then silently fails to match -- Chrome on Android
currently can't open the WebSocket connection the Match/Relay phase needs. Firefox (or any
desktop browser) works fine; use that on Android for now.

## Known open question: the daily account reset can interrupt an in-flight Job

The Owner's and JA2's own Stellar accounts get recreated from scratch (merged away, then re-funded
fresh) every time their own service (re)starts, not just on a deliberate restart -- an automatic
restart after a crash reruns the exact same reset, the same way an intentional one would. This
wipes whatever that account had going at the moment -- any open sell offer, any trustline a
reseller had just established, any Job genuinely mid-relay with an already-matched Requester.

This is now an active consideration, not just a latent one: a daily reset now runs on a fixed
schedule, in addition to whatever crash-triggered restarts already happen on their own -- the
original reasoning for resetting at all was staying ahead of Stellar testnet's own periodic
reset, ~every 3 months, by making a fresh account a non-event rather than a surprise.

**What we do today, as an interim measure:** a reset script runs at reset time, resetting the
whole demo/QA environment back to a known-clean slate -- every mTLS cert except the Owner's and
JA2's own revoked, every `/jobs` entry that isn't theirs retracted, any stray offer on either of
their own accounts cancelled, and a staleness-aware sweep of each of their own Jobs' *public*
order books too -- buying out a demo visitor's own unretracted resale once it's sat untouched past
the session TTL, since cancelling it outright isn't possible (that account's own key was never
ours to hold). That sweep's own staleness check exists specifically so this reset never
cannibalizes a visitor's own resale while it's still genuinely live. A tighter, per-grant version
of the same idea now also runs the moment resale rights are granted, independent of this reset's
own schedule -- so in the common case a stale resale is swept within its own session TTL, not just
whenever this reset next happens to run.
This is still a *blunt* fix for the restart-interrupts-an-in-flight-Job problem specifically, not a
graceful one, and it's worth being explicit about the tradeoff it accepts: running it abandons
everyone who already joined, mid-Job or not -- there's no draining, no grace period, no distinction
between a Job that's about to finish and one that just started. It solves "the reset doesn't leave
stale, misleading garbage behind" without solving "the reset doesn't interrupt anyone" -- those are
two different problems, and only the first one is handled so far.

**The proposed fix for the second problem, not yet built:** the daily schedule above only picked
*when* to run the existing, still-coupled reset -- it's still the exact same reset path a
crash-triggered restart already goes through, with no draining step of its own. The actual fix --
decoupling the reset from the restart path entirely, a pattern already proven out once on this
same project (an earlier setup kept its own daily account reset on its own fixed schedule,
entirely separate from its own crash restarts, specifically to avoid this exact coupling) --
still isn't built:

1. Suspend gating new Jobs (stop placing fresh sell offers) -- nothing new starts.
2. Wait for every already-gated Job to actually finish (PoP and PoD both landed). This is why
   Jobs are meant to be short-lived in the first place -- the wait is bounded by design, not by
   hoping it resolves quickly.
3. Force-stop anything that doesn't wrap up in a reasonable window, using the Job asset's own
   clawback flag (already set on every issued asset) rather than just waiting indefinitely.
4. Only then run the account reset.

This shrinks the exposure from "a reset can hit any in-flight Job, any time" down to "a reset
only ever happens in a window where nothing's expected to still be running" -- smaller, and
reuses a pattern already proven out elsewhere in this project. Documented here, not yet
implemented, specifically because the QA process this demo is the entry point for is expected to
run long enough that this is worth knowing about up front, not discovering mid-session.
