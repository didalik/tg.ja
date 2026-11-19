// tg/ja/public/calc.mjs -- the calc Job's own dedicated chat page {{{1
// (split out of what used to be one shared ja.mjs, ccddh.md's "a
// dedicated page per test case" round). calc is never resold today, so
// it never shows the delegation heads-up -- that's an ECHO-only thing
// (see echo.mjs). discoverIssuerFromJobs: true -- own-echo.mjs's and
// owner-echo.mjs's own copy both link here without an issuerPk (they
// only know calc's own name, not JA2's current pk), relying on this
// page to look its own real issuer up on /jobs instead.
import { runChatSession } from './lib/chat-session.mjs'

runChatSession({
  assetCode: 'CALC',
  label: 'Calc',
  matchedMessage: "Matched -- type an arithmetic expression below and hit Send, e.g. '2 + 3 * 4'. One gate trade pays for the whole session.",
  discoverIssuerFromJobs: true,
})
