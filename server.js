// One-off GHL duplicate finder for the "Fund Your Bizz" sub-account.
// Env: GHL_TOKEN (Private Integration token), LOCATION_ID, ADMIN_KEY (any long random string), PORT
// Delete this service when the cleanup is done.
const http = require("http");

const TOKEN = process.env.GHL_TOKEN;
const LOC = process.env.LOCATION_ID;
const ADMIN = process.env.ADMIN_KEY;
const CLIENT = process.env.CLIENT_KEY || "";
const PORT = process.env.PORT || 3000;
const fs = require("fs");
const path = require("path");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const F_GROUPS = path.join(DATA_DIR, "groups.json"), F_DEC = path.join(DATA_DIR, "decisions.json");
let decisions = {};
try { decisions = JSON.parse(fs.readFileSync(F_DEC, "utf8")); } catch {}
const saveDecisions = () => { try { fs.writeFileSync(F_DEC + ".tmp", JSON.stringify(decisions)); fs.renameSync(F_DEC + ".tmp", F_DEC); } catch (e) { console.error("save decisions", e.message); } };
const API = "https://services.leadconnectorhq.com";
const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" };

if (!TOKEN || !LOC || !ADMIN) { console.error("Set GHL_TOKEN, LOCATION_ID and ADMIN_KEY"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = { status: "idle", fetched: 0, started: null, finished: null, error: null, groups: [], stats: {}, deleted: [] };
let contacts = []; // kept in memory only
try { const sv = JSON.parse(fs.readFileSync(F_GROUPS, "utf8")); state.groups = sv.groups; state.status = "done"; state.finished = sv.at; state.stats = { loadedFromDisk: true, groups: sv.groups.length }; } catch {}

async function api(path, opts = {}, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(API + path, { headers: H, ...opts });
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
    const t = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${path}: ${t.slice(0, 300)}`);
    return t ? JSON.parse(t) : {};
  }
  throw new Error("Too many retries: " + path);
}

// ---------- fetch every contact ----------
async function fetchAll() {
  contacts = []; let searchAfter = null;
  for (;;) {
    const body = { locationId: LOC, pageLimit: 500 };
    if (searchAfter) body.searchAfter = searchAfter;
    const d = await api("/contacts/search", { method: "POST", body: JSON.stringify(body) });
    const rows = d.contacts || [];
    if (!rows.length) break;
    for (const c of rows) contacts.push(c);
    state.fetched = contacts.length;
    const last = rows[rows.length - 1];
    if (!last.searchAfter || rows.length < 500) break;
    searchAfter = last.searchAfter;
    await sleep(250);
  }
}

// ---------- normalisation ----------
const str = (v) => (v == null ? "" : typeof v === "string" ? v : typeof v === "object" ? str(v.email || v.phone || v.value || v.name || "") : String(v));
const normEmail = (e) => str(e).trim().toLowerCase();
const normPhone = (p) => { const d = str(p).replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };
const SUFFIX = /\b(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc|the)\b/g;
const normBiz = (b) => str(b).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").replace(SUFFIX, " ").replace(/\s+/g, " ").trim();
const normName = (n) => str(n).toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const GENERIC_EMAIL = /^(info|admin|office|support|sales|contact|hello|underwriting|uw|submissions|subs|deals|funding|noreply|no-reply)@/;
const nameOf = (c) => str(c.contactName) || [str(c.firstName), str(c.lastName)].filter(Boolean).join(" ") || "";

function view(c) {
  return { i: c.id, n: nameOf(c), b: str(c.companyName), p: str(c.phone), e: str(c.email), d: str(c.dateAdded).slice(0, 10), t: (Array.isArray(c.tags) ? c.tags : []).slice(0, 6).map(str), o: c.assignedTo ? "owned" : "" };
}
const score = (c) => (c.email ? 2 : 0) + (c.phone ? 2 : 0) + (c.companyName ? 1 : 0) + ((c.tags || []).length ? 1 : 0) + (c.assignedTo ? 1 : 0) + (c.dateUpdated ? 1 : 0);
function pickMaster(list) {
  let best = 0;
  list.forEach((c, i) => { const b = list[best]; if (score(c) > score(b) || (score(c) === score(b) && str(c.dateUpdated) > str(b.dateUpdated))) best = i; });
  return best;
}

// ---------- grouping (union-find over email / phone / business name) ----------
function analyse() {
  const parent = contacts.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  const reasons = new Map(); // root-agnostic: store per link
  const links = []; // [a,b,type]
  const idx = { email: new Map(), phone: new Map(), biz: new Map() };
  const add = (m, k, i) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(i); };

  contacts.forEach((c, i) => {
    add(idx.email, normEmail(c.email), i);
    for (const ae of Array.isArray(c.additionalEmails) ? c.additionalEmails : []) add(idx.email, normEmail(ae), i);
    add(idx.phone, normPhone(c.phone), i);
    for (const ap of Array.isArray(c.additionalPhones) ? c.additionalPhones : []) add(idx.phone, normPhone(ap), i);
    const nb = normBiz(c.companyName);
    if (nb.length >= 4) add(idx.biz, nb, i);
  });

  const BIG = 8; // buckets bigger than this are shared/generic identifiers, skip
  for (const [type, m] of Object.entries(idx)) {
    for (const [k, arr] of m) {
      const u = [...new Set(arr)];
      if (u.length < 2 || u.length > BIG) continue;
      for (let j = 1; j < u.length; j++) { union(u[0], u[j]); links.push([u[0], u[j], type, k]); }
    }
  }

  const comp = new Map();
  contacts.forEach((_, i) => { const r = find(i); if (!comp.has(r)) comp.set(r, []); comp.get(r).push(i); });

  const typeOfComp = new Map();
  for (const [a, , type, k] of links) { const r = find(a); if (!typeOfComp.has(r)) typeOfComp.set(r, new Map()); typeOfComp.get(r).set(type, k); }

  const groups = [];
  let n = 0;
  for (const [root, members] of comp) {
    if (members.length < 2) continue;
    const list = members.map((i) => contacts[i]);
    const t = typeOfComp.get(root) || new Map();
    const names = list.map((c) => normName(nameOf(c))).filter(Boolean);
    const sameName = names.length > 1 && new Set(names).size === 1;
    const bizs = list.map((c) => normBiz(c.companyName)).filter(Boolean);
    const sameBiz = bizs.length > 1 && new Set(bizs).size === 1;
    const key = t.get("email") || t.get("phone") || t.get("biz");
    const hasEmail = t.has("email") && !GENERIC_EMAIL.test(t.get("email"));
    const hasPhone = t.has("phone");
    let conf = "possible", why = "";
    if ((hasEmail || hasPhone) && (sameName || sameBiz)) { conf = "likely"; why = `Same ${[hasEmail && "email", hasPhone && "phone"].filter(Boolean).join(" + ")} and the ${sameName ? "name" : "business"} matches.`; }
    else if (hasEmail || hasPhone) { conf = "possible"; why = `Same ${hasEmail ? "email" : "phone"} but the ${sameName ? "business" : "name"} differs, so these may be different people.`; }
    else if (t.has("email")) { conf = "possible"; why = `Shared generic address (${t.get("email")}), which several people can use, so this may not be the same person.`; }
    else { conf = "possible"; why = `Only the business name matches ("${t.get("biz")}"), with no shared email or phone.`; }
    if (list.length > 4) why += ` ${list.length} records linked, so check carefully.`;
    const master = pickMaster(list);
    groups.push({ id: "G" + String(++n).padStart(5, "0"), sig: list.map((c) => c.id).sort().join("|"), type: [...t.keys()].join("+"), key, conf, sug: conf === "likely" ? "merge" : "keep", master, why, c: list.map(view) });
  }
  const rank = { likely: 0, possible: 1, diff: 2 };
  groups.sort((a, b) => rank[a.conf] - rank[b.conf] || b.c.length - a.c.length);
  groups.forEach((g, i) => (g.id = "G" + String(i + 1).padStart(5, "0")));
  state.groups = groups;
  try { fs.writeFileSync(F_GROUPS, JSON.stringify({ groups, at: new Date().toISOString() })); } catch (e) { console.error("save groups", e.message); }
  state.stats = { contacts: contacts.length, groups: groups.length, likely: groups.filter((g) => g.conf === "likely").length, possible: groups.filter((g) => g.conf === "possible").length, byType: groups.reduce((o, g) => ((o[g.type] = (o[g.type] || 0) + 1), o), {}) };
}

async function runScan() {
  if (state.status === "scanning") return;
  Object.assign(state, { status: "scanning", fetched: 0, started: new Date().toISOString(), finished: null, error: null });
  try { await fetchAll(); analyse(); state.status = "done"; }
  catch (e) { state.status = "error"; state.error = String(e.message || e); }
  state.finished = new Date().toISOString();
}

// ---------- deletes (only on explicit request; merges are done by hand in GHL) ----------
async function applyDeletes(ids, dry) {
  const valid = new Set(state.groups.flatMap((g) => g.c.map((c) => c.i)));
  const todo = ids.filter((id) => valid.has(id));
  if (dry) return { dryRun: true, wouldDelete: todo.length, ids: todo };
  const out = { deleted: 0, failed: [] };
  for (const id of todo) {
    try { await api(`/contacts/${id}`, { method: "DELETE" }); out.deleted++; state.deleted.push(id); }
    catch (e) { out.failed.push({ id, error: String(e.message).slice(0, 200) }); }
    await sleep(150);
  }
  return out;
}

// ---------- http ----------
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "x-admin-key, content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json", ...CORS }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });
const roleOf = (req, url) => { const k = req.headers["x-admin-key"] || url.searchParams.get("k"); if (k && k === ADMIN) return "admin"; if (k && CLIENT && k === CLIENT) return "client"; return null; };
const tierOf = (g) => (g.conf === "likely" ? "likely" : g.type === "biz" ? "biz" : "contact");
const decKey = (g) => g.sig || g.id;
const gdec = (g) => decisions[decKey(g)] || null;

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/") return send(res, 200, { ok: true, tool: "fyb-dedupe" });
  if (url.pathname === "/review") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(fs.readFileSync(path.join(__dirname, "review.html"))); }
  const role = roleOf(req, url);
  if (!role) return send(res, 401, { error: "bad key" });
  const isAdmin = role === "admin";

  if (url.pathname === "/status") return send(res, 200, { status: state.status, fetched: state.fetched, started: state.started, finished: state.finished, error: state.error, stats: state.stats, deletedSoFar: state.deleted.length });
  if (url.pathname === "/scan" && req.method === "POST") { if (!isAdmin) return send(res, 403, { error: "admin only" }); runScan(); return send(res, 202, { started: true }); }

  if (url.pathname === "/groups") {
    const tier = url.searchParams.get("tier"), q = (url.searchParams.get("q") || "").toLowerCase().trim(), dec = url.searchParams.get("decided");
    const off = +url.searchParams.get("offset") || 0, lim = Math.min(+url.searchParams.get("limit") || 25, 200);
    const counts = { likely: { total: 0, decided: 0 }, contact: { total: 0, decided: 0 }, biz: { total: 0, decided: 0 } };
    for (const g of state.groups) { const t = tierOf(g); counts[t].total++; if (gdec(g)) counts[t].decided++; }
    let list = state.groups;
    if (tier) list = list.filter((g) => tierOf(g) === tier);
    if (dec === "yes") list = list.filter((g) => gdec(g)); else if (dec === "no") list = list.filter((g) => !gdec(g));
    else if (["merge", "keep", "delete"].includes(dec)) list = list.filter((g) => (gdec(g) || {}).action === dec);
    if (q) list = list.filter((g) => g.c.some((c) => [c.n, c.b, c.e, c.p].join(" ").toLowerCase().includes(q)));
    const page = list.slice(off, off + lim).map((g) => ({ ...g, decision: gdec(g) }));
    return send(res, 200, { total: list.length, offset: off, counts, groups: page, scanAt: state.finished });
  }
  if (url.pathname === "/decision" && req.method === "POST") {
    const b = await readBody(req); const g = state.groups.find((x) => x.id === b.id);
    if (!g) return send(res, 404, { error: "no such group" });
    if (b.action === null) delete decisions[decKey(g)];
    else if (["merge", "keep", "delete"].includes(b.action)) decisions[decKey(g)] = { action: b.action, master: Number.isInteger(b.master) ? b.master : g.master, note: String(b.note || "").slice(0, 500), at: new Date().toISOString() };
    else return send(res, 400, { error: "bad action" });
    saveDecisions(); return send(res, 200, { ok: true, decision: gdec(g) });
  }
  if (url.pathname === "/decisions.csv") {
    const esc = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
    const rows = [["group", "tier", "decision", "keep_record_name", "keep_record_email", "keep_record_phone", "other_records", "note", "decided_at"]];
    for (const g of state.groups) { const d = gdec(g); if (!d) continue; const m = g.c[d.master] || g.c[0]; rows.push([g.id, tierOf(g), d.action, m.n, m.e, m.p, g.c.filter((_, i) => i !== d.master).map((c) => `${c.n} <${c.e || c.p}> ${c.i}`).join(" ; "), d.note, d.at]); }
    res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=fyb-duplicate-decisions.csv", ...CORS });
    return res.end(rows.map((r) => r.map(esc).join(",")).join("\n"));
  }
  if (url.pathname === "/apply" && req.method === "POST") {
    if (!isAdmin) return send(res, 403, { error: "admin only" });
    // Uses saved client decisions. body: { confirm: false }
    const b = await readBody(req); const ids = []; const manualMerges = [];
    for (const g of state.groups) {
      const d = gdec(g); if (!d) continue; const m = Number.isInteger(d.master) ? d.master : g.master;
      if (d.action === "delete") g.c.forEach((c, i) => { if (i !== m) ids.push(c.i); });
      if (d.action === "merge") manualMerges.push({ group: g.id, keep: g.c[m], mergeIn: g.c.filter((_, i) => i !== m) });
    }
    const r = await applyDeletes(ids, b.confirm !== true);
    return send(res, 200, { deletes: r, mergesToDoInGHL: manualMerges.length, manualMerges });
  }
  send(res, 404, { error: "not found" });
}).listen(PORT, () => console.log("fyb-dedupe on " + PORT));
