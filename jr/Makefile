# tg/ja/public/jr/Makefile -- `make` (or `make jr`) here starts jr, the {{{1
# Toll Gate's Job Requester. Not independently cloneable yet, unlike
# db/public/requestor -- run.js/tm.js import daeh by relative path, since
# daeh isn't published yet (see their own header comments) -- but needs no
# `npm i` of its own either way: Node resolves ws/@stellar/stellar-sdk by
# walking up to the k2 root's own node_modules.
####

PK ?= # the Agent's Stellar public key, published ahead of time
TG_MATCH_TIMEOUT_MS ?= 30000
TG_TM_TIMEOUT_MS ?= 30000

.DEFAULT_GOAL := jr

.PHONY: jr # {{{1
jr:
	@echo $@ started on $$(date)
	TG_TM_ISSUER_PK='${PK}' \
	TG_TM_TIMEOUT_MS='${TG_TM_TIMEOUT_MS}' \
	TG_MATCH_TIMEOUT_MS='${TG_MATCH_TIMEOUT_MS}' \
	node run.js
	echo $@ DONE;echo
