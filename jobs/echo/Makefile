# tg/ja/public/jobs/echo/Makefile -- daeh's job.ts spawn mode always runs {{{1
# literally `make` with cwd set to `./<aud>` (see daeh/lib/job.ts and
# ../../run.js, which offers aud: 'echo', and is run with cwd set to
# jobs/ -- see ../../jr/Makefile's own `compete` target) -- this is that
# entry point. Deliberately trivial: reads whatever the matched peer sends
# on stdin, writes it straight back out on stdout -- daeh relays that back
# over the WS as the job's output. The whole point of `ja`/`jr` is proving
# the toll-gate wiring (gate -> match -> grant -> relayTimeoutMs) works end
# to end, not the job itself.
#
# Promoted here from tg/ja/jobs/echo/Makefile (ccddh.md's "publish daeh,
# promote the Agent-offering flow" round) -- identical, just reachable from
# a standalone clone now. tg/ja/jobs/echo/Makefile stays behind unchanged.

SHELL := /bin/bash

.ONESHELL:

.PHONY: job # {{{1
job:
	@echo $@ started on $$(date) >&2; cat
