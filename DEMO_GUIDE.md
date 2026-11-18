# Joining the KoT demo

`echo` and `calc` work straight from the [intro page](https://qa.ja.tg.kloudoftrust.org) --
no setup, just click and try them. This guide is for the next step: actually joining as a Job
Agent yourself, via the `csr` Job.

`csr` needs a small helper -- the local bridge -- running on your own machine first, because it
does real work on your behalf (generating a one-off identity, requesting a real Cloudflare
certificate, buying and reselling real Job inventory) that a browser tab alone can't. See
["Details: requesting a Job, on both sides of the trade"](#details-requesting-a-job-on-both-sides-of-the-trade)
below for the underlying mechanics, and `jobs.md` for the overall pitch this demo is the entry
point for.

## One-time setup

```
git clone https://github.com/didalik/tg.ja.git k2-ja
cd k2-ja && npm i
cd jr
node bridge.mjs
```

(Needs `git` and Node.js already installed. For Android/Termux specifically, see the appendix
below -- a couple of extra packages are needed there.)

That last command starts the local bridge and leaves it running -- it prints:

```
[bridge] listening on http://localhost:8099/ -- leave this running
```

Leave this terminal open. The bridge is what talks to the KoT page on your behalf for the rest of
this -- you won't type any more commands after this point.

## Join

Back on the [intro page](https://qa.ja.tg.kloudoftrust.org), tap **csr** in the Jobs list. It
opens a new tab straight to your own bridge on `localhost:8099` (that's what the terminal you left
open is for -- if you see a connection error here instead, the bridge isn't actually running) and
everything from here happens without you typing anything else:

1. The page asks the bridge for a signed invite on your behalf. You won't see this step -- it's
   between the bridge and the KoT's own agents, settled in a few seconds
   ([details](#details-requesting-a-job-on-both-sides-of-the-trade)).
2. With that invite in hand, the bridge requests a real Cloudflare-issued certificate for a
   one-off identity it generated just for this session. A few more seconds, then the page tells
   you: **you're now a Job Agent.**
3. That identity is disposable by design -- nothing you need to clean up yourself. It, and its
   certificate, go away on their own once this demo session ends, crash or no crash.

## Watch

The page now plays out the rest of what being a Job Agent actually looks like, automatically --
you watch, you don't drive:

- your new identity buys the right to resell the Owner's own `echo` Job, and relists it at half
  the price;
- it buys `peer` from the Owner too, to pull down a working copy of the Agent code it's about to
  run;
- it implements and runs its own, separately-issued `echo` Job -- deterministic (no LLM), but it
  pays the real `calc` Job for an exact answer whenever a request looks like plain arithmetic,
  rather than guessing.

Every one of these is a real Stellar transaction and a real Job running -- nothing here is
mocked, it's just not something you had to click through yourself.

## Try it yourself

Once that's done, the page itself shows two direct links -- no need to go back to the intro page
and pick your own identity out of whatever else happens to be posted there:

- **Request the Owner's echo again** -- notice it's now cheaper than before (your own new
  identity is undercutting it, live, by DEX price alone -- nobody chose that seller for you);
- **Chat with your own echo** -- the one your own identity just stood up. Ask it something that
  needs real arithmetic (e.g. `17 * 23`), and watch it get a precise answer instead of guessing.
  That answer takes a few extra seconds, on purpose: this isn't the Owner's own plain echo, it
  pays a separate, real Job (JA2's own `calc`) for the exact answer first. The chat page itself
  tells you this the moment you're matched -- a wait here means the delegation is working, not
  that anything's stuck.

## That's it

Close the tab, close the bridge, whenever you're done. Nothing from this session is meant to
outlive it -- if you want to actually join for real afterward, that's a separate, deliberate step
(an invite someone sends you on purpose, not the demo's own disposable one), not a continuation of
this.

## Details: requesting a Job, on both sides of the trade

Step 1 above ("the page asks the bridge for a signed invite") is really the first of several
times this exact same thing happens in this guide -- csr, sell, and peer each do it again later,
just trading a different Job. Worth seeing once in full, since every other step is the same shape
with the names changed.

`buyInvite` here means one specific Stellar asset: `buyInvite:<JA2's own public key>`. Buying one
unit of it *is* the request -- there's no separate "submit a request" step, no API call, no form.
The trade itself carries the request, and it's visible to anyone, forever, on Stellar's own
ledger, the moment it fills.

**The bridge's own side (the Requester):**

1. Generates a fresh, disposable Stellar keypair -- never reused, never the identity you'll
   actually join as (that one comes later, from `csr`).
2. Establishes a trustline to `buyInvite:<JA2's PK>` (required before holding any non-native
   Stellar asset at all), then places a buy offer: 1 unit, at JA2's own going price.
3. JA2 already has a matching sell offer open and waiting, so the Stellar DEX fills this
   immediately -- this fill is the **Proof of Purchase** (PoP), a timestamped, public trade
   record, free as a side effect of the trade itself.
4. The bridge connects over a WebSocket to the shared Cloudflare Durable Object, announcing
   itself as a buyer of JA2's own `buyInvite`. The Durable Object pairs it with JA2's own
   matching connection (the **Match** phase) and relays messages between the two from then on
   (**Relay**) -- Cloudflare's own Hibernation API keeps this open with no cost for either side
   while nothing's being said.
5. Over that relay, the bridge sends what it needs (how long the invite should stay valid for)
   and gets back a real, signed invite token from JA2.
6. Finally, the bridge pays the same `buyInvite` unit straight back to JA2 -- an ordinary Stellar
   payment, and the **Proof of Delivery** (PoD): the Job genuinely ran, not just that it was paid
   for.

**JA2's own side (the Agent):**

1. Keeps exactly one `buyInvite` sell offer open at a time, waiting on the DEX.
2. Watches for it to fill (the same trade the bridge's own step 3 above causes) -- once it does,
   JA2 reads exactly who just paid straight off that trade (Horizon's trade effect carries a
   `seller` field that -- despite the name -- actually identifies the counterparty), not just that
   *someone* did.
3. Only matches a Match/Relay pairing against that specific buyer -- a different connection
   claiming the same `buyInvite` at the same moment, real payment or not, gets ignored.
4. Once paired, runs the actual `buyInvite` Job: in this demo, auto-approved, so it immediately
   generates and signs a fresh invite and sends it back over the relay. (A real deployment might
   gate this behind a human allow-list instead -- the mechanism up to this point is identical
   either way.)
5. As soon as that invite's sent, immediately posts a fresh `buyInvite` sell offer -- ready for
   whoever's next, regardless of whether the bridge's own PoD payment (step 6 above) has actually
   landed yet. JA2 doesn't wait on it: PoD is the bridge's own unilateral payment, not something
   JA2's own loop is watching for before moving on.

Two Stellar transactions (PoP, PoD) and one Cloudflare-relayed exchange in between -- no escrow,
no third party holding anything, no dispute process, because there's never a moment where either
side is trusting the other on faith. `csr`, `sell`, and `peer` later in this guide each repeat
this same sequence: a different Job name, a different payload exchanged over the relay, but the
same two Stellar transactions bookending it every time.

## Appendix: on Android (Termux)

**Status: unverified on an actual phone** -- the bridge itself is real and has been proven
end-to-end on real hardware (a Mac, an Ubuntu box), but this specific package list hasn't been
tried under Termux itself yet, so treat it as the one remaining unknown.

- Install [Termux](https://termux.dev/en/) from F-Droid, not the Play Store build -- Termux's own
  packages aren't updated there any more.
- In Termux:

  ```
  pkg install -y nodejs-lts git openssl-tool openssh
  ```

  (`openssl-tool` isn't optional -- the bridge's own `csr` step shells out to it directly to
  generate your one-off certificate request; confirmed live, it's not bundled with Termux's base
  install. `openssh` provides the `ssh`/`tar` the `peer` step uses to retrieve `tg.sh`'s own code
  from the Owner's side -- same reasoning.)
- In Termux (this part still has to be typed on the phone's own keyboard -- everything after it
  won't be):

  ```
  termux-wake-lock
  passwd
  pkill sshd; sshd
  ```

  (`termux-wake-lock` stops Android from dozing the whole session -- the bridge needs to keep
  running the entire time you're trying the demo. `passwd` sets a login password: Termux's own
  `sshd` has none by default, so skipping this leaves every connection attempt rejected. Its
  `sshd` listens on port `8022`, not the usual `22`.)
- Find the phone's own IP address (Android Settings -> Wi-Fi -> tap the connected network), then
  from a real computer on the same network:

  ```
  ssh -p 8022 <phone's IP>
  ```

  (same password you just set). From *that* session -- a real keyboard, not the phone's own --
  follow "One-time setup" above as-is.
- Open the intro page in your phone's own browser (same phone, same Termux session running).
