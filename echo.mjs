// tg/ja/public/echo.mjs -- the echo Job's own dedicated chat page {{{1
// (split out of what used to be one shared ja.mjs, ccddh.md's "a
// dedicated page per test case" round). showDelegationHeadsUp: true --
// unlike calc, this one can land on a demo visitor's own transient
// reseller instead of the Owner's own plain `cat`, which delegates
// arithmetic to a real, separate calc Job.
import { runChatSession } from './lib/chat-session.mjs'

runChatSession({
  assetCode: 'ECHO',
  label: 'Echo',
  matchedMessage: 'Matched -- type a message below and hit Send. One gate trade pays for the whole session.',
  showDelegationHeadsUp: true,
})
