# tg/ja/public/jr/Makefile -- `make` (or `make jr`) here starts jr, the {{{1
# Toll Gate's Job Requester. Not independently cloneable yet, unlike
# db/public/requestor -- run.js/gate.js import daeh by relative path, since
# daeh isn't published yet (see their own header comments) -- but needs no
# `npm i` of its own either way: Node resolves ws/@stellar/stellar-sdk by
# walking up to the k2 root's own node_modules.
####

.ONESHELL:

ENV ?= dev# | qa | prod
PK ?= # the Agent's Stellar public key, published ahead of time
SHELL := /bin/bash
TG_MATCH_TIMEOUT_MS ?= 30000
TG_GRANT_TIMEOUT_MS ?= 30000

.PHONY: jr # {{{1
# --env-file-if-exists picks up TG_JA_REGISTRY_URL from ../../.env.${ENV}
# (see ../../../Makefile's ${TEST}-reset, which writes it) -- missing is
# fine (just means PK was passed directly, or nothing's registered yet).
jr:
	@echo $@ started on $$(date)
	TG_ISSUER_PK='${PK}' \
	TG_GRANT_TIMEOUT_MS='${TG_GRANT_TIMEOUT_MS}' \
	TG_MATCH_TIMEOUT_MS='${TG_MATCH_TIMEOUT_MS}' \
	node --env-file-if-exists=../../.env.${ENV} run.js &
	echo $@ DONE;echo
