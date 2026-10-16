# tg/ja/public/jr/Makefile -- `make` (or `make jr`) here starts jr, the {{{1
# Toll Gate's Job Requester. Not independently cloneable yet, unlike
# db/public/requestor -- run.js/gate.js import daeh by relative path, since
# daeh isn't published yet (see their own header comments) -- but needs no
# `npm i` of its own either way: Node resolves ws/@stellar/stellar-sdk by
# walking up to the k2 root's own node_modules.
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
