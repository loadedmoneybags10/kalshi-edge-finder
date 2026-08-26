// ============================================================================
// Persistence — the shared paper-ledger store (Phase 2).
//
// Replaces the dashboard's per-browser localStorage with a server-side store so
// the poller and the dashboard read the SAME state. Two adapters, one interface:
//
//   STORE=file  (default)  -> ./data/state.json           — zero setup, for dev
//   STORE=kv               -> Vercel KV / Upstash Redis    — for production
//                             (needs KV_REST_API_URL + KV_REST_API_TOKEN)
//
// State is a single JSON document in the exact shape the engine uses, so nothing
// about the ledger changes — only where it lives.
// ============================================================================

import { migrate, initLedger } from "./engine.mjs";

const STORE = process.env.STORE || "file";
const KEY = "kalshi_edge_finder_state";

// ---- file adapter ----
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const FILE = process.env.STATE_FILE || "./data/state.json";

async function fileLoad() {
  try { return JSON.parse(await readFile(FILE, "utf8")); }
  catch { return null; }
}
async function fileSave(state) {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(state, null, 2));
}

// ---- Vercel KV / Upstash Redis adapter (REST; no package needed) ----
const KV_URL = process.env.KV_REST_API_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || "";
async function kvLoad() {
  const res = await fetch(`${KV_URL}/get/${KEY}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!res.ok) throw new Error(`KV get ${res.status}`);
  const { result } = await res.json();
  return result ? JSON.parse(result) : null;
}
async function kvSave(state) {
  const res = await fetch(`${KV_URL}/set/${KEY}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(JSON.stringify(state)),
  });
  if (!res.ok) throw new Error(`KV set ${res.status}`);
}

// ---- public interface ----
export async function loadState() {
  const raw = STORE === "kv" ? await kvLoad() : await fileLoad();
  return migrate(raw) || initLedger();
}
export async function saveState(state) {
  return STORE === "kv" ? kvSave(state) : fileSave(state);
}
export const storeKind = () => STORE;
