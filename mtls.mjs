// tg/ja/public/mtls.mjs -- shared mTLS client-certificate helpers, reused {{{1
// from hx's own pattern (hx/jobs/run.js's `options`/`fetch_options`, built
// the same way: an https.Agent carrying the client cert/key, passed through
// as a request option). Gated by mTLS=true in the environment, so callers
// that don't need it (most of them, for now) don't touch the filesystem at
// all.
//
// Own copy of tg/mtls.mjs (ccddh.md's "publish daeh, promote the Agent-
// offering flow" round) -- same fork tg/sh/mtls.mjs already is for the sh
// side: this repo is meant to be independently cloneable, so it can't reach
// one level up into the k2 parent repo's own tg/ at all. No env-var rename
// needed here, unlike sh's own SH_ prefix -- ja already used TG_ throughout.
//
// Two helpers, not one, because hx's own precedent only ever covered a
// plain https.request() (register.js's own use) -- an https.Agent's
// cert/key get applied through its own connection-creation logic, which
// https.request() uses by default. The `ws` package doesn't: it always
// overrides createConnection with its own tlsConnect(), which calls
// tls.connect(options) directly -- tls.connect() has no idea what an
// `agent` option even is, so an agent-wrapped cert/key silently never
// reaches the handshake at all (confirmed live: a WS connection presenting
// { agent: mtlsAgent() } showed up at the Cloudflare edge as
// certPresented: "0", despite mTLS=true -- the connection still succeeded
// regardless, since nothing was enforcing a cert either way, which is
// exactly how this went unnoticed). mtlsOptions() exists for this case --
// cert/key go directly on the options object `new WebSocket(url, options)`
// passes through, no agent involved.
//
// Env:
//   mTLS -- 'true' to build either one; any other value (or unset) makes
//           both return undefined, same as not presenting a cert.
//
// Both take an optional cert directory, now keyed by the agent's own
// Stellar PK rather than a human-chosen name (ccddh.md's "Keys and
// Certificates local storage, Redefined") -- defaults to this process's
// own TG_AGENT_PK, so a stable identity (E, P, ...) needs nothing passed
// at all, since its own cert already lives at exactly that PK's directory
// (~/.config/.cloudflare-job-fair/<pk>/cert.{pem,key}). There's no more
// shared 'jag' fallback for an identity with no cert of its own (ja's own
// rotating issuer key never gets one issued) -- that still needs an
// explicit pk pointing at some other, real identity's cert until it has
// its own.

import fs from 'node:fs'
import https from 'node:https'

const CERT_BASE = `${process.env.HOME}/.config/.cloudflare-job-fair`

function readCert (pk) { // {{{1
  if (!pk) throw new Error('mtls: no PK given and TG_AGENT_PK is unset -- which identity\'s cert?');
  const dir = `${CERT_BASE}/${pk}`
  return {
    cert: fs.readFileSync(`${dir}/cert.pem`, 'utf-8'),
    key: fs.readFileSync(`${dir}/cert.key`, 'utf-8'),
  };
}

export function mtlsAgent (pk = process.env.TG_AGENT_PK) { // {{{1
  if (process.env.mTLS !== 'true') return undefined;
  return new https.Agent({ ...readCert(pk), keepAlive: false });
}

export function mtlsOptions (pk = process.env.TG_AGENT_PK) { // for `new WebSocket(url, options)` -- see header {{{1
  if (process.env.mTLS !== 'true') return undefined;
  return readCert(pk);
}
