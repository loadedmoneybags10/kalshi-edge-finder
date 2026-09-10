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
// Accept whichever names the connected integration injects: Vercel KV uses
// KV_REST_API_*; Upstash (Marketplace) uses UPSTASH_REDIS_REST_*; some setups
// use REDIS_* / STORAGE_* aliases. First match wins. Trailing slash trimmed.
const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL ||
  process.env.REDIS_REST_URL || process.env.STORAGE_REST_API_URL || "").replace(/\/$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.REDIS_REST_TOKEN || process.env.STORAGE_REST_API_TOKEN || "";
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
// Resilient: a store hiccup never 500s the API. It records the error and falls
// back to a fresh ledger, so the dashboard still loads (in server mode) and can
// SHOW the problem instead of silently dropping to local demo mode.
let lastStoreError = null;
export function storeStatus() {
  const kvConfigured = !!(KV_URL && KV_TOKEN);
  return {
    store: STORE, kvConfigured, persistent: STORE === "kv" && kvConfigured, lastError: lastStoreError,
    warn: STORE === "kv" && !kvConfigured
      ? "STORE=kv but no KV credentials found (checked KV_REST_API_URL/TOKEN and UPSTASH_REDIS_REST_URL/TOKEN). In Vercel: connect the store to THIS project, confirm the env vars appear under Settings → Environment Variables, then REDEPLOY (env changes only apply to new deployments). Until then nothing persists."
      : STORE !== "kv"
        ? "STORE is not 'kv' — on Vercel serverless is ephemeral, so placed bets won't persist between requests. Set STORE=kv and connect a KV store."
        : null,
  };
}
export async function loadState() {
  try {
    const raw = STORE === "kv" ? await kvLoad() : await fileLoad();
    lastStoreError = null;
    return migrate(raw) || initLedger();
  } catch (e) { lastStoreError = String(e?.message || e); return initLedger(); }
}
export async function saveState(state) {
  try {
    const r = STORE === "kv" ? await kvSave(state) : await fileSave(state);
    lastStoreError = null; return r;
  } catch (e) { lastStoreError = String(e?.message || e); return { ok: false, error: lastStoreError }; }
}
export const storeKind = () => STORE;

// Live end-to-end KV check: which credential names resolved, and does an actual
// write→read round-trip succeed? Used by /api/health to pinpoint config issues.
export async function kvSelfTest() {
  const names = {
    KV_REST_API_URL: !!process.env.KV_REST_API_URL, KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
    UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
    REDIS_REST_URL: !!process.env.REDIS_REST_URL, STORAGE_REST_API_URL: !!process.env.STORAGE_REST_API_URL,
  };
  const configured = !!(KV_URL && KV_TOKEN);
  if (!configured) return { configured: false, names, note: "No KV URL/TOKEN resolved from any known env name." };
  const tk = KEY + "_selftest", val = "ok-" + Date.now();
  try {
    const setR = await fetch(`${KV_URL}/set/${tk}`, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}` }, body: val });
    if (!setR.ok) return { configured: true, names, ok: false, stage: "set", status: setR.status, body: (await setR.text()).slice(0, 200) };
    const getR = await fetch(`${KV_URL}/get/${tk}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!getR.ok) return { configured: true, names, ok: false, stage: "get", status: getR.status, body: (await getR.text()).slice(0, 200) };
    const j = await getR.json();
    return { configured: true, names, ok: j && j.result != null && String(j.result).includes(val), got: j && j.result,
      urlHost: (KV_URL.match(/^https?:\/\/[^/]+/) || [""])[0] };
  } catch (e) { return { configured: true, names, ok: false, stage: "exception", error: String(e?.message || e) }; }
}
