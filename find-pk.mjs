#!/usr/bin/env node

// tg/ja/public/find-pk.mjs -- thin CLI wrapper; the actual lookup lives {{{1
// in daeh/lib/find-pk.mjs (promoted there, same reason stellar.mjs/
// rtoj.mjs were). Lives at this submodule's own root, not under jr/, so
// jr/Makefile's own `peer` target can reach it with a plain `../find-pk.mjs`
// -- the previous `../../../find-pk.mjs` reached three levels up, straight
// past this repo's own boundary into the k2 parent repo, which a
// standalone `git clone` of this repo alone would never have.
//
// Usage: node find-pk.mjs <name>
// Prints the PK on stdout and exits 0 if found; exits 1 with nothing on
// stdout otherwise -- callers (Makefiles) just see empty output + a
// nonzero status, same as any other lookup miss.

import { findPk } from 'daeh/find-pk.mjs' // {{{1

const [name] = process.argv.slice(2)
if (!name) throw new Error('usage: node find-pk.mjs <name>');

const pk = await findPk(name)
if (pk) { console.log(pk); process.exit(0); }
process.exit(1);
