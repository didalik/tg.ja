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
# Plain `cat` again, unconditionally -- this briefly had a DEMO_ECHO=true
# branch selecting a deterministic (no LLM) stand-in that paid JA2's real
# calc Job for bare arithmetic, but that moved to tg/sh/jobs/echo/echo.mjs
# once tg/sh (not this standalone clone) became what the demo snapshot
# actually ships (and what tg/sh/broker.mjs's own queue covers). The
# whole point of `ja`/`jr` is proving the toll-gate wiring (gate -> match
# -> grant -> relay) works end to end, not the job itself -- this file
# goes back to being exactly that.

.PHONY: job # {{{1
job:
	@echo $@ started on $$(date) >&2
	@exec cat
