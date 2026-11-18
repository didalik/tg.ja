// tg/ja/public/owner-echo.mjs -- the dedicated page for bridge.mjs's {{{1
// own "request the Owner's echo again" link (split out of the generic
// /echo page, ccddh.md's "a dedicated page per test case" round, one
// level deeper than calc/echo). Still genuinely dynamic, unlike
// own-echo.mjs: this one's own issuerPk is always the real Owner's, but
// which account's own offer the DEX actually fills against depends on
// who's cheapest right now -- the real Owner, or the demo visitor's own
// transient identity undercutting it. showDelegationHeadsUp stays true.
import { runChatSession } from './lib/chat-session.mjs'

runChatSession({
  assetCode: 'ECHO',
  label: 'Echo',
  matchedMessage: 'Matched -- type a message below and hit Send. One gate trade pays for the whole session.',
  showDelegationHeadsUp: true,
})
