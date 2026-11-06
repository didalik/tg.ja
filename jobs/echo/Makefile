# tg/ja/public/jobs/echo/Makefile -- daeh's job.ts spawn mode always runs {{{1
# literally `make` with cwd set to `./<aud>` (see daeh/lib/job.ts and
# ../../run.js, which offers aud: 'echo', and is run with cwd set to
# jobs/ -- see ../../jr/Makefile's own `compete` target) -- this is that
# entry point.
#
# Promoted here from tg/ja/jobs/echo/Makefile (ccddh.md's "publish daeh,
# promote the Agent-offering flow" round) -- tg/ja/jobs/echo/Makefile
# stays behind, still the trivial `cat` pass-through Дід Alik's/JA2's
# own production echo Agents actually run.
#
# DEMO_ECHO=true selects ./demo-echo.mjs instead of plain `cat` -- a
# deterministic (no LLM) stand-in that still pays JA2's real calc Job
# for anything that looks like bare arithmetic, for a device that can't
# run a local model at all (see that file's own header). Unset (the
# default), this stays exactly the trivial pass-through it always was
# -- the whole point of `ja`/`jr` is proving the toll-gate wiring
# (gate -> match -> grant -> relayTimeoutMs) works end to end, not the
# job itself, and DEMO_ECHO=true is the one deliberate exception to that.

SHELL := /bin/bash

.ONESHELL:

.PHONY: job # {{{1
job:
	@echo $@ started on $$(date) >&2
	if [ "$$DEMO_ECHO" = 'true' ]; then
	  exec node demo-echo.mjs
	else
	  exec cat
	fi
