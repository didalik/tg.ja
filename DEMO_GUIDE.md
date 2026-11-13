# Joining the KoT demo

`echo` and `calc` work straight from the [intro page](https://qa.ja.tg.kloudoftrust.org) --
no setup, just click and try them. This guide is for the next step: actually joining as a Job
Agent yourself, via the `csr` Job.

`csr` needs a small helper -- the local bridge -- running on your own machine first, because it
does real work on your behalf (generating a one-off identity, requesting a real Cloudflare
certificate, buying and reselling real Job inventory) that a browser tab alone can't. See `dqad.md`
and `cnj.md` (root `k2` repo) for the underlying mechanics and the overall pitch this demo is the
entry point for.

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
   between the bridge and the KoT's own agents, settled in a few seconds.
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

Once that's done, the page invites you to:

- request `echo` again, from the Owner -- notice it's now cheaper than before (your own new
  identity is undercutting it);
- request the *new* `echo` your own identity just stood up, and chat with it -- ask it something
  that needs real arithmetic, and watch it get a precise answer instead of guessing.

## That's it

Close the tab, close the bridge, whenever you're done. Nothing from this session is meant to
outlive it -- if you want to actually join for real afterward, that's a separate, deliberate step
(an invite someone sends you on purpose, not the demo's own disposable one), not a continuation of
this.

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
