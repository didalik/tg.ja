# tg/ja/public/jr/Makefile -- `make` (or `make jr`) here starts jr, the {{{1
# Toll Gate's Job Requester. Not independently cloneable yet, unlike
# db/public/requestor -- run.js/gate.js import daeh by relative path, since
# daeh isn't published yet (see their own header comments) -- but needs no
# `npm i` of its own either way: Node resolves ws/@stellar/stellar-sdk by
# walking up to the k2 root's own node_modules.
####

.ONESHELL:

ENV ?= dev# | qa | prod
SHELL := /bin/bash
TG_MATCH_TIMEOUT_MS ?= 30000
TG_GRANT_TIMEOUT_MS ?= 30000

.PHONY: jr # {{{1
jr:
	@echo $@ started on $$(date)
	if [ '${ENV}' = 'dev' ]; then
		ssh alec@mba "open $$TG_JA_URL" &
	else
		TG_GRANT_TIMEOUT_MS='${TG_GRANT_TIMEOUT_MS}' \
		TG_MATCH_TIMEOUT_MS='${TG_MATCH_TIMEOUT_MS}' \
		node run.js &
	fi
	echo $@ DONE;echo
