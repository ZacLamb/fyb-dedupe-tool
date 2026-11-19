// One-off GHL duplicate finder for the "Fund Your Bizz" sub-account.
// Env: GHL_TOKEN (Private Integration token), LOCATION_ID, ADMIN_KEY (any long random string), PORT
// Delete this service when the cleanup is done.
const http = require("http");

const TOKEN = process.env.GHL_TOKEN;
const LOC = process.env.LOCATION_ID;
const ADMIN = process.env.ADMIN_KEY;
const PORT = process.env.PORT || 3000;
const API = "https://services.leadconnectorhq.com";
const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" };

if (!TOKEN || !LOC || !ADMIN) { console.error("Set GHL_TOKEN, LOCATION_ID and ADMIN_KEY"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = { status: "idle", fetched: 0, started: null, finished: null, error: null, groups: [], stats: {}, deleted: [] };
let contacts = []; // kept in memory only

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
const normEmail = (e) => (e || "").trim().toLowerCase();
const normPhone = (p) => { const d = (p || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };
const SUFFIX = /\b(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc|the)\b/g;
const normBiz = (b) => (b || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").replace(SUFFIX, " ").replace(/\s+/g, " ").trim();
const normName = (n) => (n || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const GENERIC_EMAIL = /^(info|admin|office|support|sales|contact|hello|underwriting|uw|submissions|subs|deals|funding|noreply|no-reply)@/;
const nameOf = (c) => c.contactName || [c.firstName, c.lastName].filter(Boolean).join(" ") || "";

function view(c) {
  return { i: c.id, n: nameOf(c), b: c.companyName || "", p: c.phone || "", e: c.email || "", d: (c.dateAdded || "").slice(0, 10), t: (c.tags || []).slice(0, 6), o: c.assignedTo ? "owned" : "" };
}
const score = (c) => (c.email ? 2 : 0) + (c.phone ? 2 : 0) + (c.companyName ? 1 : 0) + ((c.tags || []).length ? 1 : 0) + (c.assignedTo ? 1 : 0) + (c.dateUpdated ? 1 : 0);
function pickMaster(list) {
  let best = 0;
  list.forEach((c, i) => { const b = list[best]; if (score(c) > score(b) || (score(c) === score(b) && (c.dateUpdated || "") > (b.dateUpdated || ""))) best = i; });
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
    for (const ae of c.additionalEmails || []) add(idx.email, normEmail(ae), i);
    add(idx.phone, normPhone(c.phone), i);
    for (const ap of c.additionalPhones || []) add(idx.phone, normPhone(ap), i);
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
    groups.push({ id: "G" + String(++n).padStart(5, "0"), type: [...t.keys()].join("+"), key, conf, sug: conf === "likely" ? "merge" : "keep", master, why, c: list.map(view) });
  }
  const rank = { likely: 0, possible: 1, diff: 2 };
  groups.sort((a, b) => rank[a.conf] - rank[b.conf] || b.c.length - a.c.length);
  groups.forEach((g, i) => (g.id = "G" + String(i + 1).padStart(5, "0")));
  state.groups = groups;
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
  const valid = new Set(contacts.map((c) => c.id));
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

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/") return send(res, 200, { ok: true, tool: "fyb-dedupe", status: state.status });
  if ((req.headers["x-admin-key"] || url.searchParams.get("k")) !== ADMIN) return send(res, 401, { error: "bad key" });

  if (url.pathname === "/scan" && req.method === "POST") { runScan(); return send(res, 202, { started: true }); }
  if (url.pathname === "/status") return send(res, 200, { status: state.status, fetched: state.fetched, started: state.started, finished: state.finished, error: state.error, stats: state.stats, deletedSoFar: state.deleted.length });
  if (url.pathname === "/groups") {
    const conf = url.searchParams.get("conf"), off = +url.searchParams.get("offset") || 0, lim = Math.min(+url.searchParams.get("limit") || 200, 1000);
    const g = conf ? state.groups.filter((x) => x.conf === conf) : state.groups;
    return send(res, 200, { total: g.length, offset: off, groups: g.slice(off, off + lim) });
  }
  if (url.pathname === "/apply" && req.method === "POST") {
    // body: { decisions: { G00001: {action:"merge"|"keep"|"delete", master:0} }, confirm: false }
    const b = await readBody(req); const ids = []; const manualMerges = [];
    for (const [gid, d] of Object.entries(b.decisions || {})) {
      const g = state.groups.find((x) => x.id === gid); if (!g) continue;
      if (d.action === "delete") g.c.forEach((c, i) => { if (i !== (d.master ?? g.master)) ids.push(c.i); });
      if (d.action === "merge") manualMerges.push({ group: gid, keep: g.c[d.master ?? g.master], mergeIn: g.c.filter((_, i) => i !== (d.master ?? g.master)) });
    }
    const r = await applyDeletes(ids, b.confirm !== true);
    return send(res, 200, { deletes: r, mergesToDoInGHL: manualMerges.length, manualMerges });
  }
  send(res, 404, { error: "not found" });
}).listen(PORT, () => console.log("fyb-dedupe on " + PORT));
