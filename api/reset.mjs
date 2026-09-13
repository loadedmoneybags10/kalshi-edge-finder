// ============================================================================
// api/reset.mjs — wipe the paper account to a clean slate.
//
//   npm run reset
//
// Deletes the persisted journal (data/state.json) and the generated dashboard /
// export so the next `npm run daily` starts fresh at the current starting
// bankroll (lib/config.mjs → LEDGER.startingBankroll). Risk principles are
// unchanged (they're fractions of bankroll). Nothing else is touched.
// ============================================================================

import { rm } from "node:fs/promises";
import { LEDGER } from "../lib/config.mjs";

const files = ["data/state.json", "edge/dashboard-local.html", "edge/journal-export.json"];
for (const f of files) {
  await rm(f, { force: true });
  console.log("  removed " + f);
}
console.log(`\n✅ Account reset. Next \`npm run daily\` starts fresh at $${LEDGER.startingBankroll}.`);
