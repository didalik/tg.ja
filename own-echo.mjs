// tg/ja/public/own-echo.mjs -- the dedicated page for bridge.mjs's own {{{1
// "chat with your own echo" link (split out of the generic /echo page,
// ccddh.md's "a dedicated page per test case" round, one level deeper
// than calc/echo). Unlike /echo, this one's own issuerPk is always a
// demo visitor's own self-issued identity -- never the real Owner, no
// reseller possible -- so it always delegates to calc, with certainty,
// not "if matched against a reseller": showDelegationHeadsUp: false
// here, since this page's own copy already says so unconditionally.
import { runChatSession } from './lib/chat-session.mjs'

runChatSession({
  assetCode: 'ECHO',
  label: 'Echo',
  matchedMessage: 'Matched -- type a message and hit Send.',
})
