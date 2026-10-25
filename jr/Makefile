# tg/ja/public/jr/Makefile -- `make` (or `make jr`) here starts jr, the {{{1
# Toll Gate's Job Requester. Independently cloneable now, same as
# db/public/requestor -- run.js/gate.js/join.mjs/etc. all import daeh as a
# bare specifier (ccddh.md's "limited trust" round: daeh moved to its own
# repo, didalik/daeh), not by relative path. Needs no `npm i` of its own
# when run from inside this monorepo checkout, the way it's mostly been
# run so far -- Node resolves ws/@stellar/stellar-sdk/daeh by walking up
# to the k2 root's own node_modules either way -- but a standalone clone
# of tg/ja/public (ccddh.md's own eventual public-repo plan) will need
# its own `npm i` once it has its own package.json, to pull daeh in via
# its own git+ssh dependency instead.
####

.ONESHELL:

ENV ?= dev# | qa | prod
JOB ?= echo# | join -- which Requester script this Makefile drives (ccddh.md's
# "join Use Case BITs as templates" round): run.js (echo) auto-discovers
# TG_ISSUER_PK from the registry if unset, but join.mjs (join) has no
# registry entry of its own to discover (the registry is one slot per
# smName, not per-aud -- see register.js's own header) and always needs
# TG_ISSUER_PK/JOIN_EMAIL set explicitly by the caller, same as before this
# dispatcher existed.
SHELL := /bin/bash
TESTNET := $$HOME/.config/.testnet
TG_MATCH_TIMEOUT_MS ?= 30000
TG_GRANT_TIMEOUT_MS ?= 30000

.PHONY: jr # {{{1
jr:
	@echo $@ started on $$(date) JOB=${JOB}
	if [ '${ENV}' = 'dev' ]; then
		ssh alec@mba "open $$TG_JA_URL" &
	elif [ '${JOB}' = 'join' ]; then
		TG_GRANT_TIMEOUT_MS='${TG_GRANT_TIMEOUT_MS}' \
		TG_MATCH_TIMEOUT_MS='${TG_MATCH_TIMEOUT_MS}' \
		node join.mjs &
	else
		TG_GRANT_TIMEOUT_MS='${TG_GRANT_TIMEOUT_MS}' \
		TG_MATCH_TIMEOUT_MS='${TG_MATCH_TIMEOUT_MS}' \
		node run.js &
	fi
	echo $@ DONE;echo

.PHONY: join-cert # {{{1
join-cert:
	@echo $@ started on $$(date)
	echo '- paste the cert here to validate and store it:'
	cat | node join.mjs '${WHOAMI}'
	echo '- this completes BIT 2 for ${WHOAMI}'
	echo $@ DONE;echo

.PHONY: peer # {{{1
# BIT 3's Requester side (ccddh.md's "Approaching join Use Case BIT 3").
# request-peer.mjs/gate-p.mjs live right here too now, not under tg/sh --
# tg/ja/public is meant to eventually become a public repo (CLAUDE.md's
# own description), so this is where a real end user, with nothing but a
# BIT-2 cert, will run `make peer` to become a `ja`-kind JA themselves;
# they'll never have tg/sh available to them at all (that's Дід Alik's
# own superset-kind infrastructure -- gate.js, grant.sh, grant-root.sh,
# setup-sshd.sh, stage/ -- none of which this repo plans to ship to them).
#
# Drives request-peer.mjs via its existing HTTP API (POST /request, poll
# /status) instead of its pitch-page/browser flow -- same requestPeer()
# either way, this just automates the "click" a human would otherwise do,
# no change to that file needed. Reached from tg/bit/Makefile's own
# `peer` target through the mba-in-the-middle SSH relay (see that file's
# own header; round 48 proved the relay itself works) when the Requester
# is the phone, in this round's own topology.
#
# Resolves its own Requester identity by name (WHOAMI, default "Tosh"
# for backward compatibility with existing scripts) rather than letting
# gate-p.mjs mint a fresh throwaway keypair every run -- once this
# Requester becomes a real JA (BIT 4), it should already have a stable
# identity behind it, same reasoning Дід Alik/JA2's own stable keys
# have. Previously hardcoded to "Tosh" -- a leftover from this BIT's own
# first proof, not an intentional restriction; any real end user running
# this needs their own name to resolve here instead.
#
# find-pk.mjs now lives at this repo's own root (one level up from here),
# not three levels up in the k2 parent repo -- a standalone clone of this
# repo alone never had that path at all (caught running BIT 3 for a real
# applicant, JA3, cloned standalone rather than from a full k2 checkout).
#
# Env: SH_ISSUER_PK (required -- the real Owner's own Stellar public key,
# see request-peer.mjs's own header) passed straight through from
# whoever invokes this; nothing resolved locally here for it, unlike
# SH_P_SK below -- a real end user has no access to Дід Alik's own
# ~/.config/.cloudflare-job-fair/ name->PK mapping, but this Requester's
# own identity does live wherever this actually runs.
SH_LOCAL_PORT ?= 8098
WHOAMI ?= Tosh
peer:
	@echo $@ started on $$(date) WHOAMI=${WHOAMI}
	set -e
	P_PK=$$(node ../find-pk.mjs '${WHOAMI}')
	read SH_P_SK < "${TESTNET}/$$P_PK.sk"
	export SH_P_SK
	node request-peer.mjs &
	SERVER_PID=$$!
	trap 'kill $$SERVER_PID 2>/dev/null' EXIT
	node -e '
	  const base = "http://127.0.0.1:${SH_LOCAL_PORT}";
	  const sleep = ms => new Promise(r => setTimeout(r, ms));
	  (async () => {
	    for (let i = 0; i < 20; i++) { // wait for the server to come up
	      try { await fetch(base + "/status"); break; } catch { await sleep(500); }
	    }
	    await fetch(base + "/request", { method: "POST" });
	    let s;
	    do {
	      await sleep(1000);
	      s = await (await fetch(base + "/status")).json();
	    } while (s.status === "running");
	    console.log(s.log.join("\n"));
	    process.exit(s.status === "done" ? 0 : 1);
	  })();
	'
	echo $@ DONE;echo
