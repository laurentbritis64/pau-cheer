/* Pau Cheerleading : application du club
   Données partagées via Supabase (comptes, planning, tchats, déplacements, documents). */
"use strict";

const CFG = window.PAU_CONFIG || {};
const $app = document.getElementById("app");
const BUCKET = "club-files";
const DOC_TYPES = ["Certificat médical", "Autorisation parentale", "Fiche sanitaire", "Droit à l'image", "Licence FFFA"];
const DEFAULT_ITEMS = ["Tenue de compétition complète", "Nœud et chaussures de cheer", "Pique-nique et bouteille d'eau", "Licence FFFA"];

/* ============ Outils ============ */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = n => (n || "?").trim().split(/\s+/).map(x => x[0]).join("").slice(0, 2).toUpperCase();
const first = n => (n || "").trim().split(/\s+/)[0] || "";
const hm = t => (t || "").slice(0, 5);
const iso = d => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };
const todayIso = () => iso(new Date());
const addDays = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return iso(d); };
const fmtDay = s => new Date(s + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const fmtShort = s => new Date(s + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
const fmtDate = ts => new Date(ts).toLocaleDateString("fr-FR");
function fmtTs(ts) {
  const d = new Date(ts), n = new Date();
  return d.toDateString() === n.toDateString()
    ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}
const fmtSize = b => !b ? "" : b > 1e6 ? (b / 1e6).toFixed(1).replace(".", ",") + " Mo" : Math.max(1, Math.round(b / 1e3)) + " Ko";
const safeName = n => (n || "fichier").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "_").slice(-80);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
function toast(msg) {
  const t = document.getElementById("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 2600);
}
function fail(e, msg) { console.error(e); toast(msg || "Une erreur est survenue. Vérifie ta connexion et réessaie."); }

const I = {
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  bus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 21v-3M16 21v-3"/></svg>',
  mega: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 10v4h3l8 5V5L6 10z"/><path d="M18 9a4 4 0 0 1 0 6"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 12l-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5M9 13h7M9 17h5"/></svg>',
};

/* ============ État ============ */
let sb = null;
let session = null;
let me = null;          // mon profil
let myEmail = "";
let D = null;           // données chargées
let S = { tab: "planning", view: null, filter: "all", limit: 40 };
let recovery = false;
let installEvt = null;
const urlCache = {};

const P = id => (D && D.P[id]) || { id, full_name: "Ancien membre", role: "pending" };
const T = id => D.teams.find(t => t.id === id) || { id, name: id, color: "#888" };
const isBureau = () => me && me.role === "bureau";

function childrenOf(pid) { return D.links.filter(l => l.parent_id === pid).map(l => P(l.athlete_id)).filter(a => a.role === "athlete"); }
function parentsOf(aid) { return D.links.filter(l => l.athlete_id === aid).map(l => P(l.parent_id)); }
function myTeams() {
  if (isBureau()) return D.teams.map(t => t.id);
  if (me.role === "athlete") return me.team_id ? [me.team_id] : [];
  return [...new Set(childrenOf(me.id).map(c => c.team_id).filter(Boolean))].sort((a, b) => T(a).position - T(b).position);
}
function myAthletes() { return me.role === "athlete" ? [me] : me.role === "parent" ? childrenOf(me.id) : []; }
function childrenIn(team) { return me.role === "parent" ? childrenOf(me.id).filter(c => c.team_id === team) : []; }
function athletes() { return Object.values(D.P).filter(p => p.role === "athlete").sort((a, b) => a.full_name.localeCompare(b.full_name)); }
function roleLabel(u) {
  if (u.role === "bureau") return (u.title ? u.title + " · " : "") + "Bureau";
  if (u.role === "athlete") return "Athlète" + (u.team_id ? " · " + T(u.team_id).name : "");
  if (u.role === "parent") { const c = childrenOf(u.id); return c.length ? "Parent de " + c.map(x => first(x.full_name)).join(", ") : "Parent"; }
  return "En attente de validation";
}
const teamChip = id => { const t = T(id); return `<span class="chip" style="padding:3px 9px;font-size:12px"><span class="dot" style="background:${t.color}"></span>${esc(t.name)}</span>`; };

/* Conversations */
const dmPair = other => [me.id, other].sort();
function convOf(m) { return m.team_id ? "team:" + m.team_id : "dm:" + (m.dm_a === me.id ? m.dm_b : m.dm_a); }
function msgsOf(key) { return D.msgs.filter(m => convOf(m) === key).sort((a, b) => a.created_at.localeCompare(b.created_at)); }
function readMap() { return store.get("pau-read-" + me.id, {}); }
function markRead(key) { const r = readMap(); r[key] = new Date().toISOString(); store.set("pau-read-" + me.id, r); }
function unreadIn(key) { const r = readMap()[key] || "1970"; return D.msgs.filter(m => convOf(m) === key && m.sender_id !== me.id && m.created_at > r).length; }
function dmPartners() { return isBureau() ? Object.values(D.P).filter(p => p.id !== me.id && p.role !== "pending") : Object.values(D.P).filter(p => p.role === "bureau"); }
function totalUnread() {
  let n = 0;
  for (const t of myTeams()) n += unreadIn("team:" + t);
  const seen = new Set(D.msgs.filter(m => !m.team_id).map(convOf));
  for (const k of seen) n += unreadIn(k);
  return n;
}

/* ============ Démarrage ============ */
function boot() {
  if (!CFG.url || !CFG.anonKey || !window.supabase) {
    $app.innerHTML = `<div class="login pad"><div class="brand"><img src="icons/logo.webp" alt="Logo Pau Cheerleading"><div class="logo">Pau<br><span>Cheerleading</span></div></div>
      <div class="card"><b>L'application n'est pas encore reliée à sa base de données.</b><p class="muted" style="margin:6px 0 0">Il faut renseigner l'adresse du projet Supabase et sa clé publique dans le fichier config.js.</p></div></div>`;
    return;
  }
  sb = window.supabase.createClient(CFG.url, CFG.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  sb.auth.onAuthStateChange((evt, s) => {
    if (evt === "PASSWORD_RECOVERY") { recovery = true; session = s; render(); return; }
    const changed = (s && s.user && s.user.id) !== (session && session.user && session.user.id);
    session = s;
    if (changed) start();
  });
  sb.auth.getSession().then(({ data }) => { session = data.session; start(); });
  window.addEventListener("online", render);
  window.addEventListener("offline", render);
}

let starting = null;
async function start() {
  if (!session) { me = null; D = null; render(); return; }
  if (starting) return starting;
  $app.innerHTML = `<div class="loading">Chargement…</div>`;
  starting = (async () => {
    try {
      const uid = session.user.id;
      const { data: prof, error } = await sb.from("profiles").select("*").eq("id", uid).maybeSingle();
      if (error) throw error;
      me = prof || { id: uid, full_name: "", role: "pending" };
      myEmail = session.user.email || "";
      if (me.role === "pending") { D = null; render(); return; }
      await loadAll();
      subscribe();
      render();
    } catch (e) { fail(e, "Impossible de charger les données."); $app.innerHTML = `<div class="loading pad">Impossible de charger les données. <button class="btn small" onclick="location.reload()">Réessayer</button></div>`; }
    finally { starting = null; }
  })();
  return starting;
}

async function q(promise) { const { data, error } = await promise; if (error) throw error; return data || []; }
async function loadAll() {
  const since = addDays(todayIso(), -1);
  const [teams, profs, links, events, evTeams, trips, steps, items, presence, packed, docs, msgs] = await Promise.all([
    q(sb.from("teams").select("*").order("position")),
    q(sb.from("profiles").select("id,full_name,role,team_id,title")),
    q(sb.from("parent_links").select("*")),
    q(sb.from("events").select("*").gte("date", since).order("date").order("start_time").limit(3000)),
    q(sb.from("event_teams").select("*").limit(10000)),
    q(sb.from("trips").select("*")),
    q(sb.from("trip_steps").select("*").order("time")),
    q(sb.from("trip_items").select("*").order("position")),
    q(sb.from("trip_presence").select("*")),
    q(sb.from("trip_packed").select("*")),
    q(sb.from("documents").select("*").order("created_at")),
    q(sb.from("messages").select("*").order("created_at", { ascending: false }).limit(600)),
  ]);
  const Pm = {}; profs.forEach(p => Pm[p.id] = p); Pm[me.id] = Object.assign(Pm[me.id] || {}, me);
  const evT = {}; evTeams.forEach(x => (evT[x.event_id] = evT[x.event_id] || []).push(x.team_id));
  events.forEach(e => e.teams = (evT[e.id] || []).sort((a, b) => (teams.find(t => t.id === a) || {}).position - (teams.find(t => t.id === b) || {}).position));
  D = { teams, P: Pm, links, events, trips, steps, items, presence, packed, docs, msgs };
}
async function reload() { try { await loadAll(); render(); } catch (e) { fail(e); } }

let channel = null;
function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel("messages-live")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, ({ new: m }) => {
      if (!D || D.msgs.some(x => x.id === m.id)) return;
      D.msgs.push(m);
      const open = S.tab === "chats" && S.view && S.view.kind === "conv" && S.view.key === convOf(m);
      if (open) markRead(convOf(m));
      else if (m.sender_id !== me.id) toast((m.is_announcement ? "Annonce de " : "Message de ") + first(P(m.sender_id).full_name));
      render(open);
    })
    .subscribe();
}

/* ============ Navigation et rendu ============ */
function go(tab, view = null) {
  if (tab !== S.tab) { S.docFor = null; S.confirm = null; }
  S.tab = tab; S.view = view; render();
  window.scrollTo(0, view && view.kind === "conv" ? document.body.scrollHeight : 0);
}

function render(keepBottom) {
  // garder ce qui est en train d'être tapé
  const active = document.activeElement && document.activeElement.id;
  const vals = {}; $app.querySelectorAll("input[id],textarea[id],select[id]").forEach(el => { if (el.type !== "file" && el.type !== "checkbox") vals[el.id] = el.value; });
  const y = window.scrollY, atBottom = window.innerHeight + y >= document.body.scrollHeight - 40;

  if (!session) { $app.innerHTML = authView(); bindAuth(); return; }
  if (recovery) { $app.innerHTML = recoveryView(); bindAuth(); return; }
  if (!me || me.role === "pending" || !D) { $app.innerHTML = pendingView(); bindAuth(); return; }

  const tabs = [["planning", "Planning", I.cal], ["chats", "Tchats", I.chat], ["trips", "Déplacements", I.bus], ["docs", "Documents", I.doc]];
  if (isBureau()) tabs.push(["bureau", "Bureau", I.mega]);
  let title = "", body = "", back = null, composer = "";
  const v = S.view;
  try {
    if (S.tab === "account") { title = "Mon compte"; body = accountView(); back = () => go("planning"); }
    if (S.tab === "planning") { title = "Planning"; body = planningView(); }
    if (S.tab === "chats") {
      if (v && v.kind === "conv") { const r = convView(v.key); title = r.title; body = r.body; composer = r.composer; back = () => go("chats"); }
      else { title = "Tchats"; body = chatsView(); }
    }
    if (S.tab === "trips") {
      if (v && v.kind === "trip") { title = "Déplacement"; body = tripView(v.id); back = () => go("trips"); }
      else { title = "Déplacements"; body = tripsView(); }
    }
    if (S.tab === "docs") { title = "Documents"; body = docsView(); }
    if (S.tab === "bureau") {
      if (v && v.kind === "annonce") { title = "Annonce"; body = annonceView(); back = () => go("bureau"); }
      else if (v && v.kind === "addEvent") { title = "Ajouter au planning"; body = addEventView(); back = () => go("bureau"); }
      else if (v && v.kind === "member") { title = "Fiche membre"; body = memberView(v.id); back = () => go("bureau"); }
      else { title = "Espace bureau"; body = bureauView(); }
    }
  } catch (e) { console.error(e); body = `<div class="empty">Cette page n'a pas pu s'afficher.</div>`; }

  const un = totalUnread();
  $app.innerHTML = `
    ${navigator.onLine ? "" : `<div class="offline">Pas de connexion internet : les nouveautés s'afficheront au retour du réseau.</div>`}
    <header class="top pad">
      ${back ? `<button class="back" id="back" aria-label="Retour">‹</button>` : `<img class="hlogo" src="icons/logo.webp" alt="">`}
      <h1>${esc(title)}</h1>
      <button class="who" id="who" title="Mon compte"><span class="av">${initials(me.full_name)}</span>${esc(first(me.full_name) || "Mon compte")}</button>
    </header>
    <main class="pad">${body}</main>
    ${composer}
    <nav class="tabs"><div class="inner" style="--n:${tabs.length}">
      ${tabs.map(([id, l, ic]) => `<button data-tab="${id}" ${S.tab === id ? 'aria-current="page"' : ""}>${ic}${l}${id === "chats" && un ? `<span class="badge">${un}</span>` : ""}</button>`).join("")}
    </div></nav>`;
  if (back) document.getElementById("back").onclick = back;
  document.getElementById("who").onclick = () => go("account");
  $app.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => go(b.dataset.tab));
  if (!S.skipRestore) for (const id in vals) { const el = document.getElementById(id); if (el) el.value = vals[id]; }
  S.skipRestore = false;
  if (active) { const el = document.getElementById(active); if (el) el.focus({ preventScroll: true }); }
  if (keepBottom === true && atBottom) window.scrollTo(0, document.body.scrollHeight);
  else if (keepBottom !== undefined) window.scrollTo(0, y);
  bind();
  fillImages();
}

/* ============ Connexion ============ */
function authView() {
  const m = S.auth || "login";
  const head = `<div class="brand"><img src="icons/logo.webp" alt="Logo Pau Cheerleading"><div class="eyebrow">Application du club</div><div class="logo">Pau<br><span>Cheerleading</span></div></div>`;
  if (m === "signup") return `<div class="login pad">${head}
    <form id="signup" class="authbox"><h2>Créer mon compte</h2>
      <label class="field">Prénom et nom<input id="suName" autocomplete="name" required></label>
      <label class="field">E-mail<input id="suEmail" type="email" autocomplete="email" required></label>
      <label class="field">Mot de passe (8 caractères minimum)<input id="suPass" type="password" autocomplete="new-password" minlength="8" required></label>
      <div class="err" id="authErr" hidden></div>
      <button class="btn">Créer mon compte</button>
      <p class="muted" style="margin:0;font-size:13px">Après la création, un membre du bureau valide ton compte et le relie à ton équipe ou à tes enfants.</p>
      <button type="button" class="link" data-auth="login">J'ai déjà un compte</button></form></div>`;
  if (m === "forgot") return `<div class="login pad">${head}
    <form id="forgot" class="authbox"><h2>Mot de passe oublié</h2>
      <label class="field">E-mail<input id="fgEmail" type="email" autocomplete="email" required></label>
      <div class="err" id="authErr" hidden></div>
      <button class="btn">Recevoir un lien par e-mail</button>
      <button type="button" class="link" data-auth="login">Retour</button></form></div>`;
  return `<div class="login pad">${head}
    <form id="login" class="authbox"><h2>Connexion</h2>
      <label class="field">E-mail<input id="liEmail" type="email" autocomplete="email" required></label>
      <label class="field">Mot de passe<input id="liPass" type="password" autocomplete="current-password" required></label>
      <div class="err" id="authErr" hidden></div>
      <button class="btn">Se connecter</button>
      <button type="button" class="link" data-auth="forgot">Mot de passe oublié ?</button></form>
    <div class="card stack"><b>Pas encore de compte ?</b><span class="muted" style="font-size:13.5px">Athlètes et parents créent leur compte ici, puis le bureau le valide.</span><button class="btn ghost" data-auth="signup">Créer mon compte</button></div>
    ${installCard()}</div>`;
}
function recoveryView() {
  return `<div class="login pad"><form id="newpass" class="authbox"><h2>Nouveau mot de passe</h2>
    <label class="field">Nouveau mot de passe (8 caractères minimum)<input id="npPass" type="password" autocomplete="new-password" minlength="8" required></label>
    <div class="err" id="authErr" hidden></div><button class="btn">Enregistrer</button></form></div>`;
}
function pendingView() {
  return `<div class="login pad"><div class="brand"><img src="icons/logo.webp" alt="Logo Pau Cheerleading"><div class="logo">Bienvenue${me && me.full_name ? ",<br><span>" + esc(first(me.full_name)) + "</span>" : ""}</div></div>
    <div class="card stack"><b>Ton compte attend la validation du bureau.</b>
    <span class="muted">Un membre du bureau va le relier à ton équipe (athlète) ou à tes enfants (parent). Tu pourras ensuite voir le planning et les tchats.</span>
    <button class="btn" id="refresh">Actualiser</button></div>
    ${installCard()}
    <button class="link" id="logout">Se déconnecter</button></div>`;
}
function authErr(msg) { const e = document.getElementById("authErr"); if (e) { e.textContent = msg; e.hidden = false; } }
function frError(e) {
  const m = (e && e.message || "").toLowerCase();
  if (m.includes("invalid login")) return "E-mail ou mot de passe incorrect.";
  if (m.includes("already registered")) return "Un compte existe déjà avec cet e-mail. Utilise « Mot de passe oublié » si besoin.";
  if (m.includes("email not confirmed")) return "Confirme d'abord ton adresse avec le lien reçu par e-mail.";
  if (m.includes("rate limit")) return "Trop de tentatives. Réessaie dans quelques minutes.";
  if (m.includes("password")) return "Le mot de passe doit faire au moins 8 caractères.";
  return "Ça n'a pas marché. Vérifie ta connexion et réessaie.";
}
function bindAuth() {
  $app.querySelectorAll("[data-auth]").forEach(b => b.onclick = () => { S.auth = b.dataset.auth; render(); });
  const val = id => document.getElementById(id).value.trim();
  const busy = (f, on) => { const b = f.querySelector(".btn"); if (b) { b.disabled = on; b.style.opacity = on ? .6 : 1; } };
  const li = document.getElementById("login");
  if (li) li.onsubmit = async ev => { ev.preventDefault(); busy(li, true);
    const { error } = await sb.auth.signInWithPassword({ email: val("liEmail"), password: document.getElementById("liPass").value });
    busy(li, false); if (error) authErr(frError(error)); };
  const su = document.getElementById("signup");
  if (su) su.onsubmit = async ev => { ev.preventDefault(); busy(su, true);
    const { data, error } = await sb.auth.signUp({ email: val("suEmail"), password: document.getElementById("suPass").value,
      options: { data: { full_name: val("suName") }, emailRedirectTo: location.origin + location.pathname } });
    busy(su, false);
    if (error) return authErr(frError(error));
    if (!data.session) { S.auth = "login"; render(); toast("Compte créé : clique sur le lien reçu par e-mail pour l'activer."); } };
  const fg = document.getElementById("forgot");
  if (fg) fg.onsubmit = async ev => { ev.preventDefault(); busy(fg, true);
    const { error } = await sb.auth.resetPasswordForEmail(val("fgEmail"), { redirectTo: location.origin + location.pathname });
    busy(fg, false); if (error) return authErr(frError(error)); S.auth = "login"; render(); toast("Si un compte existe, un e-mail vient d'être envoyé."); };
  const np = document.getElementById("newpass");
  if (np) np.onsubmit = async ev => { ev.preventDefault();
    const { error } = await sb.auth.updateUser({ password: document.getElementById("npPass").value });
    if (error) return authErr(frError(error)); recovery = false; toast("Mot de passe enregistré"); start(); };
  const rf = document.getElementById("refresh"); if (rf) rf.onclick = () => start();
  const lo = document.getElementById("logout"); if (lo) lo.onclick = () => sb.auth.signOut();
  bindInstall();
}

/* ============ Installation sur l'écran d'accueil ============ */
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
function installCard() {
  if (isStandalone()) return "";
  if (installEvt) return `<div class="card install"><img src="icons/icon-192.png" width="44" height="44" alt="" style="border-radius:10px"><span style="flex:1"><b>Installer l'application</b><br><span class="muted" style="font-size:13px">Une icône sur ton écran d'accueil, comme une vraie appli.</span></span><button class="btn small" id="installBtn">Installer</button></div>`;
  if (isIOS()) return `<div class="card install"><img src="icons/icon-192.png" width="44" height="44" alt="" style="border-radius:10px"><span style="flex:1;font-size:13.5px"><b>Installer sur iPhone</b><br>Dans Safari, touche le bouton <b>Partager</b> puis <b>Sur l'écran d'accueil</b>.</span></div>`;
  return "";
}
function bindInstall() {
  const b = document.getElementById("installBtn");
  if (b) b.onclick = async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; render(); };
}
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; if (sb) render(); });

/* ============ Mon compte ============ */
function accountView() {
  return `<div class="card stack"><div class="row"><span class="av" style="width:48px;height:48px;font-size:16px">${initials(me.full_name)}</span><span><b style="font-size:17px">${esc(me.full_name)}</b><br><span class="muted">${esc(roleLabel(me))}</span></span></div>
      <span class="muted" style="font-size:13.5px">${esc(myEmail)}</span></div>
    <form id="nameForm" class="card stack"><h2>Mon nom</h2><label class="field">Prénom et nom<input id="accName" value="${esc(me.full_name)}" required></label><button class="btn small" style="align-self:flex-start">Enregistrer</button></form>
    <form id="passForm" class="card stack"><h2>Changer de mot de passe</h2><label class="field">Nouveau mot de passe<input id="accPass" type="password" minlength="8" autocomplete="new-password" required></label><button class="btn small" style="align-self:flex-start">Changer</button></form>
    ${installCard()}
    <button class="btn ghost" id="logout">Se déconnecter</button>`;
}

/* ============ Planning ============ */
function planningView() {
  const teams = myTeams();
  const f = S.filter !== "all" && teams.includes(S.filter) ? S.filter : "all";
  const today = todayIso();
  const evs = D.events.filter(e => e.date >= today && e.teams.some(t => f === "all" ? teams.includes(t) : t === f));
  const shown = evs.slice(0, S.limit);
  const byDay = {}; shown.forEach(e => (byDay[e.date] = byDay[e.date] || []).push(e));
  const nextComp = evs.find(e => e.type === "comp" && tripOfEvent(e.id));
  let intro = "";
  if (me.role === "parent") {
    const kids = childrenOf(me.id);
    intro = kids.length ? `<div class="notice">${I.user}<span>Tu vois le planning de <b>${kids.map(c => esc(first(c.full_name))).join(", ")}</b>.</span></div>`
      : `<div class="notice">${I.user}<span>Aucun enfant n'est encore relié à ton compte. Demande au bureau de le faire.</span></div>`;
  }
  return `${intro}
    ${teams.length > 1 ? `<div class="chips"><button class="chip" data-filter="all" aria-pressed="${f === "all"}">Toutes</button>${teams.map(t => `<button class="chip" data-filter="${esc(t)}" aria-pressed="${f === t}"><span class="dot" style="background:${T(t).color}"></span>${esc(T(t).name)}</button>`).join("")}</div>` : ""}
    ${nextComp ? `<button class="card" data-trip="${tripOfEvent(nextComp.id).id}" style="text-align:left;display:flex;flex-direction:column;gap:4px;border-color:var(--gold)">
      <span class="eyebrow" style="color:var(--accent)">Prochaine compétition</span>
      <span style="font-weight:800;font-family:var(--display);font-size:18px">${esc(nextComp.title)}</span>
      <span class="muted">${fmtDay(nextComp.date)} · ${esc(nextComp.place)}</span>
      <span style="font-weight:700;color:var(--accent)">Voir le départ et le déroulé ›</span></button>` : ""}
    ${Object.keys(byDay).map(d => `<div class="daygroup"><div class="daylabel">${d === today ? "Aujourd'hui · " : ""}${fmtDay(d)}</div>
      ${byDay[d].map(eventCard).join("")}</div>`).join("") || `<div class="empty">Rien de prévu pour le moment.</div>`}
    ${evs.length > shown.length ? `<button class="btn ghost" data-more>Voir la suite du planning</button>` : ""}`;
}
function eventCard(e) {
  const teams = myTeams(), tr = tripOfEvent(e.id);
  const kids = me.role === "parent" ? e.teams.flatMap(childrenIn).map(c => first(c.full_name)) : [];
  return `<div class="card ev ${e.type}">
    <div class="time">${hm(e.start_time)}<small>${hm(e.end_time)}</small></div>
    <div class="body"><div class="row" style="gap:6px;flex-wrap:wrap"><span class="tag ${e.type === "comp" ? "comp" : "train"}">${e.type === "comp" ? "Compétition" : "Entraînement"}</span>${e.teams.filter(t => teams.includes(t)).map(teamChip).join("")}</div>
      <div class="title">${esc(e.title)}</div><div class="muted" style="font-size:13px">${esc(e.place)}</div>
      ${kids.length ? `<div style="font-size:13px">Concerne : ${kids.map(esc).join(", ")}</div>` : ""}
      <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:2px">
        ${tr ? `<button class="btn small" data-trip="${tr.id}">Voir le déplacement</button>` : ""}
        ${isBureau() ? (S.confirm === e.id ? `<button class="btn small danger" data-delev="${e.id}">Confirmer la suppression</button><button class="btn small ghost" data-cancel>Annuler</button>` : `<button class="btn small ghost" data-askdel="${e.id}">Supprimer</button>`) : ""}
      </div>
    </div></div>`;
}

/* ============ Tchats ============ */
function lastOf(key) { const l = msgsOf(key); return l[l.length - 1]; }
function preview(m) { return m ? (m.is_announcement ? "📣 " : "") + first(P(m.sender_id).full_name) + " : " + (m.body || (m.file_name ? "📎 " + m.file_name : "")) : ""; }
function chatsView() {
  const teams = myTeams();
  const teamRows = teams.map(t => {
    const key = "team:" + t, m = lastOf(key), n = unreadIn(key), tm = T(t);
    const sub = me.role === "parent" ? "Pour " + childrenIn(t).map(c => first(c.full_name)).join(", ") : "Athlètes, parents et bureau";
    return `<button class="item" data-conv="${key}"><span class="gico" style="background:${tm.color}">${esc(tm.name[0])}</span>
      <span class="txt"><span class="t1">Équipe ${esc(tm.name)}${n ? `<span class="tag comp">${n}</span>` : ""}</span><span class="t2">${esc(m ? preview(m) : sub)}</span></span>
      <span class="when">${m ? fmtTs(m.created_at) : ""}</span></button>`;
  }).join("") || `<div class="item muted">Aucune équipe pour l'instant.</div>`;
  let partners = dmPartners();
  if (isBureau()) {
    const withMsgs = new Set(D.msgs.filter(m => !m.team_id).map(convOf).map(k => k.slice(3)));
    partners = partners.filter(p => withMsgs.has(p.id));
  }
  partners.sort((a, b) => ((lastOf("dm:" + b.id) || {}).created_at || "").localeCompare((lastOf("dm:" + a.id) || {}).created_at || ""));
  const dmRows = partners.map(dmRow).join("") || `<div class="item muted">Aucune conversation privée pour l'instant.</div>`;
  return `
    <div class="eyebrow">${me.role === "athlete" ? "Mon équipe" : me.role === "parent" ? "Équipes de mes enfants" : "Toutes les équipes"}</div>
    <div class="list">${teamRows}</div>
    <div class="row" style="justify-content:space-between"><div class="eyebrow">Messages privés</div>${isBureau() ? `<button class="btn small ghost" data-tab="bureau">Écrire à quelqu'un</button>` : ""}</div>
    <div class="list">${dmRows}</div>
    <div class="notice">${I.lock}<span>${isBureau() ? "Les messages privés ne sont visibles que par toi et la personne concernée." : "Les messages privés avec le bureau ne sont visibles par personne d'autre."}</span></div>`;
}
function dmRow(p) {
  const key = "dm:" + p.id, m = lastOf(key), n = unreadIn(key);
  return `<button class="item" data-conv="${key}"><span class="av" style="width:40px;height:40px;font-size:14px">${initials(p.full_name)}</span>
    <span class="txt"><span class="t1">${esc(p.full_name)}${n ? `<span class="tag comp">${n}</span>` : ""}</span><span class="t2">${esc(m ? (m.body || "📎 " + m.file_name) : roleLabel(p))}</span></span>
    <span class="when">${m ? fmtTs(m.created_at) : ""}</span></button>`;
}
function fileHtml(f) {
  const img = (f.file_type || "").startsWith("image/");
  return `${img ? `<img class="thumb" data-path="${esc(f.file_path)}" alt="">` : ""}<button class="file" data-open="${esc(f.file_path)}" style="border:0;background:none;padding:0;color:inherit;text-align:left"><span class="fi">${I.doc}</span><span style="min-width:0"><span class="fn">${esc(f.file_name)}</span><small>${fmtSize(f.file_size)} · ouvrir</small></span></button>`;
}
function convView(key) {
  const [type, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  let title, note;
  if (type === "team") { const t = T(id); title = "Équipe " + t.name; note = `<div class="notice">${I.user}<span>Groupe de l'équipe ${esc(t.name)} : athlètes, parents et bureau.</span></div>`; }
  else { const p = P(id); title = p.full_name; note = `<div class="notice">${I.lock}<span>Conversation privée avec <b>${esc(p.full_name)}</b> (${esc(roleLabel(p))}).</span></div>`; }
  markRead(key);
  if (!S.loadedConv || S.loadedConv !== key) { S.loadedConv = key; loadConv(key); }
  const list = msgsOf(key);
  const body = `${note}<div class="chat">${list.map(m => {
    const a = P(m.sender_id), mine = m.sender_id === me.id;
    return `<div class="msg ${mine && !m.is_announcement ? "me" : ""} ${m.is_announcement ? "annonce" : ""}"><span class="meta">${m.is_announcement ? "📣 Annonce du bureau · " + esc(a.full_name) : mine ? "Moi" : esc(a.full_name) + " · " + esc(roleLabel(a))} · ${fmtTs(m.created_at)}</span><div class="bubble">${m.file_path ? fileHtml(m) : ""}${m.body ? esc(m.body) : ""}</div></div>`;
  }).join("") || `<div class="empty">Aucun message. Écris le premier !</div>`}</div>`;
  const composer = `<div class="composer"><form id="send" class="pad"><label class="btn clip" title="Joindre un document" aria-label="Joindre un document">${I.clip}<input type="file" id="chatfile" hidden accept="image/*,.pdf,.doc,.docx"></label><input id="msg" autocomplete="off" placeholder="Écrire un message…" aria-label="Message"><button class="btn">Envoyer</button></form></div>`;
  return { title, body, composer };
}
async function loadConv(key) {
  try {
    let qy = sb.from("messages").select("*").order("created_at", { ascending: false }).limit(300);
    if (key.startsWith("team:")) qy = qy.eq("team_id", key.slice(5));
    else { const [a, b] = dmPair(key.slice(3)); qy = qy.eq("dm_a", a).eq("dm_b", b); }
    const rows = await q(qy);
    let added = 0; rows.forEach(m => { if (!D.msgs.some(x => x.id === m.id)) { D.msgs.push(m); added++; } });
    if (added) render(true);
  } catch (e) { fail(e); }
}
function target(key) {
  if (key.startsWith("team:")) return { team_id: key.slice(5) };
  const [a, b] = dmPair(key.slice(3)); return { dm_a: a, dm_b: b };
}
async function sendMessage(key, body, file) {
  const row = { ...target(key), sender_id: me.id, body: body || "" };
  if (file) {
    const folder = key.startsWith("team:") ? "chat/team/" + key.slice(5) : "chat/dm/" + dmPair(key.slice(3)).join("_");
    const path = `${folder}/${Date.now()}-${safeName(file.name)}`;
    const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined });
    if (error) throw error;
    Object.assign(row, { file_path: path, file_name: file.name, file_size: file.size, file_type: file.type });
  }
  const { data, error } = await sb.from("messages").insert(row).select().single();
  if (error) throw error;
  if (!D.msgs.some(x => x.id === data.id)) D.msgs.push(data);
  markRead(key);
}
async function signedUrl(path) {
  if (urlCache[path] && urlCache[path].exp > Date.now()) return urlCache[path].url;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error) throw error;
  urlCache[path] = { url: data.signedUrl, exp: Date.now() + 3500e3 };
  return data.signedUrl;
}
async function fillImages() {
  for (const img of $app.querySelectorAll("img[data-path]")) {
    try { img.src = await signedUrl(img.dataset.path); } catch (e) { img.remove(); }
  }
}

/* ============ Déplacements ============ */
const tripOfEvent = eid => tripList().find(t => t.event_id === eid);
function tripList() { return Array.isArray(D.trips) ? D.trips : Object.values(D.trips); }
function eventOf(tr) { return D.events.find(e => e.id === tr.event_id); }
function itemsOf(tid) { return D.items.filter(i => i.trip_id === tid).sort((a, b) => a.position - b.position); }
function concerned(tr) {
  const e = eventOf(tr); if (!e) return [];
  return myAthletes().filter(a => e.teams.includes(a.team_id));
}
function presenceOf(tid, aid) { const p = D.presence.find(x => x.trip_id === tid && x.athlete_id === aid); return p && p.status; }
function packedOf(tid, aid) { const ids = new Set(itemsOf(tid).map(i => i.id)); return D.packed.filter(p => p.athlete_id === aid && ids.has(p.item_id)).map(p => p.item_id); }
function tripsView() {
  const teams = myTeams(), today = todayIso();
  const list = tripList().map(tr => ({ tr, e: eventOf(tr) })).filter(x => x.e && x.e.date >= today && x.e.teams.some(t => teams.includes(t))).sort((a, b) => a.e.date.localeCompare(b.e.date));
  if (!list.length) return `<div class="empty">Aucun déplacement prévu.${isBureau() ? "<br>Ajoute une compétition depuis l'espace bureau." : ""}</div>`;
  return `<p class="muted" style="margin:0">Pour chaque compétition : départ, transport, déroulé de la journée et affaires à emporter.</p>` + list.map(({ tr, e }) => {
    const c = concerned(tr), n = itemsOf(tr.id).length;
    const ok = c.length && c.every(a => presenceOf(tr.id, a.id) === "yes");
    return `<button class="card" data-trip="${tr.id}" style="text-align:left;display:flex;flex-direction:column;gap:6px">
      <div class="row" style="justify-content:space-between"><span class="tag comp">${fmtShort(e.date)}</span>${c.length ? (ok ? `<span class="tag ok">Présence confirmée</span>` : `<span class="tag warn">À confirmer</span>`) : ""}</div>
      <span style="font-weight:800;font-family:var(--display);font-size:17px">${esc(e.title)}</span>
      <span class="row" style="gap:6px;flex-wrap:wrap">${e.teams.filter(t => teams.includes(t)).map(teamChip).join("")}</span>
      <span class="muted" style="font-size:13.5px">${tr.depart_time ? "Départ " + hm(tr.depart_time) + " · " : ""}${esc(tr.depart_place)}</span>
      ${c.map(a => { const k = packedOf(tr.id, a.id).length; return n ? `<span class="row" style="gap:8px;font-size:13px"><span style="flex:none">🎒 ${c.length > 1 ? esc(first(a.full_name)) + " : " : "Sac : "}${k}/${n}</span><span class="bar" style="flex:1"><i style="width:${k / n * 100}%"></i></span></span>` : ""; }).join("")}
    </button>`;
  }).join("");
}
function tripView(id) {
  const tr = tripList().find(t => t.id === id); if (!tr) return `<div class="empty">Ce déplacement n'existe plus.</div>`;
  const e = eventOf(tr), teams = myTeams(), c = concerned(tr);
  let presence = "";
  if (c.length) presence = `<div class="card stack"><h2>Présence</h2>${c.map(a => { const st = presenceOf(id, a.id);
    return `<div class="row" style="justify-content:space-between;flex-wrap:wrap"><span><b>${esc(first(a.full_name))}</b> ${teamChip(a.team_id)}</span>
      <span class="row" style="gap:6px"><button class="btn small ${st === "yes" ? "" : "ghost"}" data-conf="${a.id}:yes">Présent·e</button><button class="btn small ${st === "no" ? "" : "ghost"}" data-conf="${a.id}:no">Absent·e</button></span></div>`; }).join("")}</div>`;
  if (isBureau()) { const ath = athletes().filter(a => e.teams.includes(a.team_id));
    presence = `<div class="card stack"><h2>Présences (${ath.filter(a => presenceOf(id, a.id) === "yes").length}/${ath.length})</h2>${ath.map(a => { const st = presenceOf(id, a.id);
      return `<div class="row" style="justify-content:space-between"><span>${esc(a.full_name)} ${teamChip(a.team_id)}</span>${st === "yes" ? '<span class="tag ok">Présent·e</span>' : st === "no" ? '<span class="tag comp">Absent·e</span>' : '<span class="tag warn">Sans réponse</span>'}</div>`; }).join("") || '<span class="muted">Aucun athlète dans ces équipes.</span>'}</div>`; }
  const steps = D.steps.filter(s => s.trip_id === id).sort((a, b) => a.time.localeCompare(b.time));
  const edit = isBureau() && S.editTrip === id;
  return `
    <div class="hero">
      <span class="lbl">${fmtDay(e.date)}</span><h2>${esc(e.title)}</h2>
      <div class="grid"><div><div class="lbl">Départ</div><div class="big">${tr.depart_time ? hm(tr.depart_time) : "–"}</div></div>
        <div><div class="lbl">Retour</div><div style="font-weight:700;font-size:18px;margin-top:6px">${esc(tr.return_time || "–")}</div></div></div>
      <div><div class="lbl">Rendez-vous</div><div style="font-weight:600">${esc(tr.depart_place || "À préciser")}</div></div>
      <div><div class="lbl">Transport</div><div style="font-weight:600">${esc(tr.transport || "À préciser")}</div></div>
      <div><div class="lbl">Lieu de la compétition</div><div style="font-weight:600">${esc(e.place)}</div></div>
    </div>
    ${isBureau() ? (edit ? `<form id="tripForm" class="card stack"><h2>Modifier le déplacement</h2>
        <div class="grid2"><label class="field">Heure de départ<input id="tfTime" type="time" value="${hm(tr.depart_time)}"></label><label class="field">Retour prévu<input id="tfRet" value="${esc(tr.return_time)}"></label></div>
        <label class="field">Lieu de rendez-vous<input id="tfPlace" value="${esc(tr.depart_place)}"></label>
        <label class="field">Transport<input id="tfTransport" value="${esc(tr.transport)}"></label>
        <label class="field">Responsable et téléphone<input id="tfContact" value="${esc(tr.contact)}"></label>
        <div class="row"><button class="btn small">Enregistrer</button><button type="button" class="btn small ghost" data-canceledit>Annuler</button></div></form>`
      : `<button class="btn small ghost" data-edittrip="${id}" style="align-self:flex-start">Modifier le départ, le transport…</button>`) : ""}
    ${presence}
    <div class="card stack"><h2>Déroulé de la journée</h2><div class="timeline">${steps.map(s => `<div class="step"><span class="h">${hm(s.time)}</span><span class="bul"></span><span class="row" style="justify-content:space-between;align-items:flex-start"><span>${esc(s.label)}</span>${isBureau() ? `<button class="x" style="border:0;background:none;color:var(--muted);font-size:18px" data-delstep="${s.id}" aria-label="Retirer">×</button>` : ""}</span></div>`).join("") || '<span class="muted">Le déroulé sera bientôt précisé.</span>'}</div>
      ${isBureau() ? `<form id="addstep" class="row" style="gap:6px"><input id="stH" type="time" aria-label="Heure" class="search" style="width:110px"><input id="stL" aria-label="Étape" placeholder="Nouvelle étape" class="search"><button class="btn small">Ajouter</button></form>` : ""}
    </div>
    ${bringBlock(tr)}
    ${tr.contact ? `<div class="card"><div class="eyebrow">Responsable du déplacement</div><div style="font-weight:600;margin-top:4px">${esc(tr.contact)}</div></div>` : ""}
    <div class="row" style="flex-wrap:wrap">${e.teams.filter(t => teams.includes(t)).map(t => `<button class="btn small ghost" data-conv="team:${t}">Tchat ${esc(T(t).name)}</button>`).join("")}</div>`;
}
function bringBlock(tr) {
  const id = tr.id, items = itemsOf(id), t = items.length;
  if (isBureau()) {
    const e = eventOf(tr), ath = athletes().filter(a => e.teams.includes(a.team_id));
    const ready = ath.filter(a => t && packedOf(id, a.id).length === t).length;
    return `<div class="card stack"><h2>À emporter</h2>
      <p class="muted" style="margin:0;font-size:13px">Chaque athlète ou parent coche cette liste en préparant le sac. Tu peux ajouter ou retirer des affaires.</p>
      <div>${items.map(i => `<div class="check"><span>${esc(i.label)}</span><button class="x" data-delitem="${i.id}" aria-label="Retirer ${esc(i.label)}">×</button></div>`).join("") || '<div class="muted">Aucune affaire dans la liste.</div>'}</div>
      <form id="addbring" class="row" style="gap:6px"><input id="brTxt" class="search" placeholder="Ex : Crème solaire, coussin…" aria-label="Nouvelle affaire"><button class="btn small">Ajouter</button></form>
      <div class="eyebrow" style="margin-top:6px">Sacs prêts : ${ready}/${ath.length}</div>
      ${ath.map(a => { const n = packedOf(id, a.id).length; return `<div class="row" style="font-size:13.5px"><span style="flex:1;min-width:0">${esc(a.full_name)}</span><span class="bar" style="width:90px"><i style="width:${t ? n / t * 100 : 0}%"></i></span><span style="width:34px;text-align:right;font-variant-numeric:tabular-nums">${n}/${t}</span></div>`; }).join("")}
    </div>`;
  }
  const c = concerned(tr); if (!c.length || !t) return "";
  const sel = c.find(a => a.id === S.packFor) || c[0];
  const done = new Set(packedOf(id, sel.id)), n = done.size;
  return `<div class="card stack"><div class="row" style="justify-content:space-between"><h2>À emporter</h2>${n === t ? '<span class="tag ok">Sac prêt ✓</span>' : `<span class="tag warn">${t - n} à préparer</span>`}</div>
    ${c.length > 1 ? `<div class="packtabs">${c.map(a => `<button class="chip" data-packfor="${a.id}" aria-pressed="${a.id === sel.id}">Sac de ${esc(first(a.full_name))} · ${packedOf(id, a.id).length}/${t}</button>`).join("")}</div>` : ""}
    <div class="row" style="gap:10px"><span class="bar" style="flex:1"><i style="width:${n / t * 100}%"></i></span><span style="font-weight:700;font-variant-numeric:tabular-nums">${n}/${t}</span></div>
    <div>${items.map(i => `<label class="check ${done.has(i.id) ? "done" : ""}"><input type="checkbox" data-pack="${sel.id}|${i.id}" ${done.has(i.id) ? "checked" : ""}><span>${esc(i.label)}</span></label>`).join("")}</div>
    <p class="muted" style="margin:0;font-size:12.5px">${c.length > 1 ? "Une liste par enfant." : "Coche au fur et à mesure que tu prépares ton sac."} Le bureau voit qui a terminé.</p>
  </div>`;
}

/* ============ Documents ============ */
function docsOf(aid) { return D.docs.filter(d => d.athlete_id === aid); }
function docsView() {
  if (isBureau() && !S.docFor) return bureauDocs();
  const kids = isBureau() ? [P(S.docFor)] : myAthletes();
  if (!kids.length) return `<div class="empty">Aucun enfant n'est encore relié à ton compte. Demande au bureau de le faire.</div>`;
  const sel = kids.find(a => a.id === S.docFor) || kids[0], d = docsOf(sel.id);
  const have = DOC_TYPES.filter(t => d.some(x => x.doc_type === t)).length;
  const ro = isBureau(), other = d.filter(x => !DOC_TYPES.includes(x.doc_type));
  return `${ro ? `<button class="btn small ghost" data-docback style="align-self:flex-start">‹ Tous les athlètes</button>` : `<div class="notice">${I.lock}<span>Les documents envoyés ici ne sont visibles que par <b>le bureau</b>${me.role === "parent" ? " et les parents de l'enfant" : ""}.</span></div>`}
    ${kids.length > 1 ? `<div class="chips">${kids.map(a => `<button class="chip" data-docfor="${a.id}" aria-pressed="${a.id === sel.id}"><span class="dot" style="background:${T(a.team_id).color}"></span>${esc(first(a.full_name))}</button>`).join("")}</div>` : ""}
    <div class="card stack">
      <div class="row" style="justify-content:space-between"><h2>Dossier de ${esc(first(sel.full_name))}</h2>${have === DOC_TYPES.length ? '<span class="tag ok">Complet</span>' : `<span class="tag warn">${DOC_TYPES.length - have} manquant${DOC_TYPES.length - have > 1 ? "s" : ""}</span>`}</div>
      <div class="row" style="gap:10px"><span class="bar" style="flex:1"><i style="width:${have / DOC_TYPES.length * 100}%"></i></span><span style="font-weight:700;font-variant-numeric:tabular-nums">${have}/${DOC_TYPES.length}</span></div>
      <div>${DOC_TYPES.map(t => { const f = d.filter(x => x.doc_type === t).pop();
        return `<div class="doc"><span class="file"><span class="fi" style="${f ? "background:var(--ok-soft);color:var(--ok)" : ""}">${I.doc}</span></span>
          <span class="txt"><b>${esc(t)}</b>${f ? `<button class="link" style="font-size:13px;padding:0;font-weight:500" data-open="${esc(f.file_path)}">${esc(f.file_name)}</button><small>envoyé le ${fmtDate(f.created_at)} par ${esc(first(P(f.uploaded_by).full_name))}</small>` : "<small>Pas encore envoyé</small>"}</span>
          ${ro ? (f ? '<span class="tag ok">Reçu</span>' : '<span class="tag warn">Manquant</span>') : `<label class="btn small ${f ? "ghost" : ""}">${f ? "Remplacer" : "Envoyer"}<input type="file" hidden data-docup="${sel.id}|${esc(t)}" accept="image/*,.pdf,.doc,.docx"></label>`}</div>`; }).join("")}</div>
    </div>
    <div class="card stack"><h2>Autres documents</h2>
      ${other.map(f => `<div class="doc"><span class="txt"><b>${esc(f.doc_type)}</b><button class="link" style="font-size:13px;padding:0;font-weight:500" data-open="${esc(f.file_path)}">${esc(f.file_name)}</button><small>${fmtDate(f.created_at)}</small></span></div>`).join("") || '<p class="muted" style="margin:0">Attestation, justificatif d\'absence, photo…</p>'}
      ${ro ? "" : `<label class="btn small ghost" style="align-self:flex-start">Envoyer un autre document<input type="file" hidden data-docup="${sel.id}|Autre document" accept="image/*,.pdf,.doc,.docx"></label>`}</div>
    ${ro ? "" : `<p class="muted" style="margin:0;font-size:12.5px">Tu peux aussi joindre un document dans un tchat avec le trombone. Photo, PDF ou Word, 10 Mo maximum.</p>`}`;
}
function bureauDocs() {
  const ath = athletes();
  const missing = a => DOC_TYPES.filter(x => !docsOf(a.id).some(y => y.doc_type === x));
  const complete = ath.filter(a => !missing(a).length).length;
  return `<div class="card"><div class="eyebrow">Dossiers complets</div><div style="font-family:var(--display);font-size:28px;font-weight:800">${complete}/${ath.length}</div></div>
    ${D.teams.map(t => { const l = ath.filter(a => a.team_id === t.id); if (!l.length) return "";
      return `<div class="daylabel">Équipe ${esc(t.name)}</div><div class="list">${l.map(a => { const m = missing(a), n = DOC_TYPES.length - m.length;
        return `<button class="item" data-docfor="${a.id}"><span class="av" style="width:36px;height:36px">${initials(a.full_name)}</span><span class="txt"><span class="t1">${esc(a.full_name)}</span><span class="t2">${m.length ? "Manque : " + esc(m.join(", ")) : "Dossier complet"}</span></span><span class="tag ${m.length ? "warn" : "ok"}">${n}/${DOC_TYPES.length}</span></button>`; }).join("")}</div>`; }).join("") || `<div class="empty">Aucun athlète pour l'instant.</div>`}`;
}
async function uploadDoc(aid, type, file) {
  const path = `documents/${aid}/${Date.now()}-${safeName(file.name)}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined });
  if (error) throw error;
  const { data, error: e2 } = await sb.from("documents").insert({ athlete_id: aid, doc_type: type, file_path: path, file_name: file.name, file_size: file.size, file_type: file.type, uploaded_by: me.id }).select().single();
  if (e2) throw e2;
  D.docs.push(data);
}

/* ============ Bureau ============ */
function bureauView() {
  const qs = (S.q || "").toLowerCase();
  const all = Object.values(D.P).filter(p => p.id !== me.id);
  const pending = all.filter(p => p.role === "pending");
  const groups = [["Bureau", all.filter(p => p.role === "bureau")],
    ...D.teams.map(t => ["Équipe " + t.name, [...all.filter(p => p.role === "athlete" && p.team_id === t.id), ...all.filter(p => p.role === "parent" && childrenOf(p.id).some(c => c.team_id === t.id))]]),
    ["Sans équipe ni enfant relié", all.filter(p => (p.role === "athlete" && !p.team_id) || (p.role === "parent" && !childrenOf(p.id).length))]];
  return `
    ${pending.length ? `<div class="card stack" style="border-color:var(--gold)"><h2>${pending.length} compte${pending.length > 1 ? "s" : ""} à valider</h2>
      <div class="list">${pending.map(p => `<button class="item" data-member="${p.id}"><span class="av" style="width:36px;height:36px">${initials(p.full_name)}</span><span class="txt"><span class="t1">${esc(p.full_name || "Sans nom")}</span><span class="t2">Choisir : athlète, parent ou bureau</span></span><span class="tag warn">Valider</span></button>`).join("")}</div></div>` : ""}
    <div class="grid2">
      <button class="card" data-goview="annonce" style="text-align:left;display:flex;flex-direction:column;gap:6px;border-color:var(--gold)"><span style="color:var(--accent)">${I.mega}</span><b>Annonce à toutes les équipes</b><span class="muted" style="font-size:13px">Publiée dans chaque tchat d'équipe</span></button>
      <button class="card" data-goview="addEvent" style="text-align:left;display:flex;flex-direction:column;gap:6px"><span style="color:var(--accent)">${I.cal}</span><b>Ajouter au planning</b><span class="muted" style="font-size:13px">Entraînement ou compétition</span></button>
    </div>
    <div class="eyebrow">Membres du club · message privé ou fiche</div>
    <input class="search" id="q" placeholder="Rechercher un nom…" aria-label="Rechercher">
    ${groups.map(([g, l]) => { l = l.filter(p => p.full_name.toLowerCase().includes(qs)); if (!l.length) return "";
      return `<div class="daylabel">${esc(g)}</div><div class="list">${l.map(p => `<div class="item"><span class="av" style="width:36px;height:36px">${initials(p.full_name)}</span><span class="txt"><span class="t1">${esc(p.full_name)}</span><span class="t2">${esc(roleLabel(p))}</span></span><button class="btn small ghost" data-member="${p.id}">Fiche</button><button class="btn small" data-conv="dm:${p.id}" aria-label="Message privé à ${esc(p.full_name)}">${I.lock}</button></div>`).join("")}</div>`; }).join("")}`;
}
function memberView(id) {
  const p = P(id);
  if (!S.memberEmail || S.memberEmail.id !== id) { S.memberEmail = { id, email: "…" }; sb.from("profile_private").select("email").eq("id", id).maybeSingle().then(({ data }) => { S.memberEmail = { id, email: (data && data.email) || "" }; const el = document.getElementById("mEmailTxt"); if (el) el.textContent = S.memberEmail.email; }); }
  const role = S.mRole || p.role;
  const kids = new Set(S.mKids || D.links.filter(l => l.parent_id === id).map(l => l.athlete_id));
  return `<form id="memberForm" class="stack">
    <div class="card stack"><div class="row"><span class="av" style="width:44px;height:44px">${initials(p.full_name)}</span><span><b>${esc(p.full_name || "Sans nom")}</b><br><span class="muted" id="mEmailTxt" style="font-size:13px">${esc(S.memberEmail.email)}</span></span></div></div>
    <label class="field">Prénom et nom<input id="mName" value="${esc(p.full_name)}" required></label>
    <label class="field">Rôle<select id="mRole">
      ${[["pending", "En attente (aucun accès)"], ["athlete", "Athlète"], ["parent", "Parent"], ["bureau", "Membre du bureau"]].map(([v, l]) => `<option value="${v}" ${role === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    ${role === "athlete" ? `<label class="field">Équipe<select id="mTeam"><option value="">Choisir…</option>${D.teams.map(t => `<option value="${t.id}" ${p.team_id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>` : ""}
    ${role === "bureau" ? `<label class="field">Fonction<input id="mTitle" value="${esc(p.title || "")}" placeholder="Président, trésorière, coach…"></label>` : ""}
    ${role === "parent" ? `<div class="field">Enfants (un ou plusieurs)<div class="card" style="padding:4px 12px">${athletes().map(a => `<label class="check"><input type="checkbox" name="mkid" value="${a.id}" ${kids.has(a.id) ? "checked" : ""}><span>${esc(a.full_name)} ${a.team_id ? teamChip(a.team_id) : ""}</span></label>`).join("") || '<span class="muted">Valide d\'abord les comptes des athlètes.</span>'}</div></div>` : ""}
    ${role === "athlete" ? `<p class="muted" style="margin:0;font-size:13px">Parents reliés : ${parentsOf(id).map(x => esc(x.full_name)).join(", ") || "aucun pour l'instant (à faire depuis la fiche du parent)"}.</p>` : ""}
    <button class="btn">Enregistrer</button>
    <button type="button" class="btn ghost" data-conv="dm:${id}">Envoyer un message privé</button>
  </form>`;
}

function annonceView() {
  return `<div class="notice">${I.mega}<span>Le message sera publié dans <b>chaque tchat d'équipe choisi</b>. Pour une information personnelle, utilise plutôt un message privé.</span></div>
  <form id="annonce" class="stack">
    <div class="field">Équipes concernées<div class="chips" style="flex-wrap:wrap">${D.teams.map(t => `<label class="chip"><input type="checkbox" name="tm" value="${t.id}" checked> ${esc(t.name)}</label>`).join("")}</div></div>
    <label class="field">Message<textarea id="annTxt" rows="5" placeholder="Ex : pas d'entraînement pendant les vacances de Noël…" required></textarea></label>
    <button class="btn">Publier l'annonce</button></form>`;
}
function addEventView() {
  const comp = S.evType === "comp";
  return `<form id="addev" class="stack">
    <label class="field">Type<select id="evType"><option value="train" ${comp ? "" : "selected"}>Entraînement</option><option value="comp" ${comp ? "selected" : ""}>Compétition</option></select></label>
    <label class="field">Titre<input id="evTitle" value="${comp ? "" : "Entraînement"}" placeholder="${comp ? "Ex : Championnat régional" : ""}" required></label>
    <div class="field">Équipes<div class="chips" style="flex-wrap:wrap">${D.teams.map(t => `<label class="chip"><input type="checkbox" name="evtm" value="${t.id}"> ${esc(t.name)}</label>`).join("")}</div></div>
    <label class="field">Date<input id="evDate" type="date" value="${addDays(todayIso(), 7)}" required></label>
    <div class="grid2"><label class="field">Début<input id="evS" type="time" value="${comp ? "09:00" : "18:00"}" required></label><label class="field">Fin<input id="evE" type="time" value="${comp ? "18:00" : "20:00"}" required></label></div>
    <label class="field">Lieu<input id="evPlace" value="${comp ? "" : "Salle Sainte-Ursule, Pau"}" required></label>
    ${comp ? `<div class="stack"><div class="eyebrow">Déplacement</div>
      <div class="grid2"><label class="field">Heure de départ<input id="trTime" type="time" value="07:00"></label><label class="field">Retour prévu<input id="trRet" value="vers 20:00"></label></div>
      <label class="field">Lieu de rendez-vous<input id="trPlace" value="Salle Sainte-Ursule, Pau"></label>
      <label class="field">Transport<input id="trTransport" placeholder="Bus du club, covoiturage…"></label>
      <label class="field">Responsable et téléphone<input id="trContact" value="${esc(me.full_name)}"></label>
      <p class="muted" style="margin:0;font-size:13px">Une liste « À emporter » de base est créée, tu pourras la modifier dans le déplacement.</p></div>`
    : `<label class="check"><input type="checkbox" id="evRepeat"><span>Répéter chaque semaine jusqu'au</span></label><input id="evUntil" type="date" class="search" value="2027-06-30">`}
    <button class="btn">Ajouter au planning</button></form>`;
}

/* ============ Actions ============ */
function bind() {
  const on = (sel, fn, evt = "onclick") => $app.querySelectorAll(sel).forEach(el => el[evt] = ev => fn(el, ev));
  on("[data-filter]", b => { S.filter = b.dataset.filter; S.limit = 40; render(); });
  on("[data-more]", () => { S.limit += 60; render(0); });
  on("[data-trip]", b => { S.editTrip = null; go("trips", { kind: "trip", id: b.dataset.trip }); });
  on("[data-conv]", b => { S.loadedConv = null; go("chats", { kind: "conv", key: b.dataset.conv }); });
  on("[data-goview]", b => { S.evType = "train"; go("bureau", { kind: b.dataset.goview }); });
  on("[data-member]", b => { S.mRole = null; S.mKids = null; go("bureau", { kind: "member", id: b.dataset.member }); });
  on("[data-askdel]", b => { S.confirm = b.dataset.askdel; render(0); });
  on("[data-cancel]", () => { S.confirm = null; render(0); });
  on("[data-delev]", async b => { try { await q(sb.from("events").delete().eq("id", b.dataset.delev).select()); D.events = D.events.filter(e => e.id !== b.dataset.delev); S.confirm = null; render(0); toast("Supprimé du planning"); } catch (e) { fail(e); } });
  on("[data-open]", async b => { try { const u = await signedUrl(b.dataset.open); window.open(u, "_blank", "noopener"); } catch (e) { fail(e, "Impossible d'ouvrir ce fichier."); } });
  on("[data-packfor]", b => { S.packFor = b.dataset.packfor; render(0); });
  on("[data-docfor]", b => { S.docFor = b.dataset.docfor; render(); window.scrollTo(0, 0); });
  on("[data-docback]", () => { S.docFor = null; render(); });
  on("[data-edittrip]", b => { S.editTrip = b.dataset.edittrip; render(0); });
  on("[data-canceledit]", () => { S.editTrip = null; render(0); });

  on("[data-conf]", async b => {
    const [aid, st] = b.dataset.conf.split(":"), tid = S.view.id;
    try { await q(sb.from("trip_presence").upsert({ trip_id: tid, athlete_id: aid, status: st, updated_by: me.id, updated_at: new Date().toISOString() }).select());
      D.presence = D.presence.filter(p => !(p.trip_id === tid && p.athlete_id === aid)).concat([{ trip_id: tid, athlete_id: aid, status: st }]);
      render(0); toast(st === "yes" ? "Présence confirmée" : "Absence notée"); } catch (e) { fail(e); }
  });
  on("[data-pack]", async b => {
    const [aid, item] = b.dataset.pack.split("|"), tid = S.view.id;
    try {
      if (b.checked) { await q(sb.from("trip_packed").upsert({ item_id: item, athlete_id: aid }).select()); D.packed.push({ item_id: item, athlete_id: aid }); }
      else { await q(sb.from("trip_packed").delete().eq("item_id", item).eq("athlete_id", aid).select()); D.packed = D.packed.filter(p => !(p.item_id === item && p.athlete_id === aid)); }
      render(0); if (packedOf(tid, aid).length === itemsOf(tid).length) toast("Sac prêt, rien n'est oublié 🎉");
    } catch (e) { b.checked = !b.checked; fail(e); }
  }, "onchange");
  on("[data-delitem]", async b => { try { await q(sb.from("trip_items").delete().eq("id", b.dataset.delitem).select()); D.items = D.items.filter(i => i.id !== b.dataset.delitem); render(0); toast("Retiré de la liste"); } catch (e) { fail(e); } });
  on("[data-delstep]", async b => { try { await q(sb.from("trip_steps").delete().eq("id", b.dataset.delstep).select()); D.steps = D.steps.filter(i => i.id !== b.dataset.delstep); render(0); } catch (e) { fail(e); } });
  on("[data-docup]", async inp => {
    const f = inp.files[0]; if (!f) return; const [aid, type] = inp.dataset.docup.split("|");
    if (f.size > 10 * 1024 * 1024) return toast("Fichier trop lourd (10 Mo maximum).");
    toast("Envoi en cours…");
    try { await uploadDoc(aid, type, f); render(0); toast("Document envoyé"); } catch (e) { fail(e, "L'envoi n'a pas marché. Réessaie."); }
  }, "onchange");

  const form = (id, fn) => { const f = document.getElementById(id); if (f) f.onsubmit = async ev => { ev.preventDefault(); const b = f.querySelector("button:not([type=button])"); if (b) b.disabled = true; try { await fn(f); } catch (e) { fail(e); } finally { if (b && document.body.contains(b)) b.disabled = false; } }; };
  const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };

  const qi = document.getElementById("q");
  if (qi) { qi.value = S.q || ""; qi.oninput = () => { S.q = qi.value; render(0); }; }

  form("send", async () => {
    const t = val("msg"); if (!t) return;
    document.getElementById("msg").value = "";
    await sendMessage(S.view.key, t); render(); window.scrollTo(0, document.body.scrollHeight); document.getElementById("msg").focus();
  });
  const cf = document.getElementById("chatfile");
  if (cf) cf.onchange = async () => { const f = cf.files[0]; if (!f) return;
    if (f.size > 10 * 1024 * 1024) return toast("Fichier trop lourd (10 Mo maximum).");
    toast("Envoi en cours…");
    try { const t = val("msg"); document.getElementById("msg").value = ""; await sendMessage(S.view.key, t, f); render(); window.scrollTo(0, document.body.scrollHeight); toast("Document envoyé"); }
    catch (e) { fail(e, "L'envoi n'a pas marché. Réessaie."); } };

  form("annonce", async f => {
    const t = val("annTxt"), tms = [...f.querySelectorAll("[name=tm]:checked")].map(x => x.value);
    if (!t || !tms.length) return toast("Choisis au moins une équipe.");
    const rows = await q(sb.from("messages").insert(tms.map(team_id => ({ team_id, sender_id: me.id, body: t, is_announcement: true }))).select());
    rows.forEach(m => { if (!D.msgs.some(x => x.id === m.id)) D.msgs.push(m); });
    go("chats"); toast(`Annonce publiée dans ${tms.length} tchat${tms.length > 1 ? "s" : ""}`);
  });

  const ty = document.getElementById("evType");
  if (ty) ty.onchange = () => { S.evType = ty.value; S.skipRestore = true; render(0); };
  form("addev", async f => {
    const tms = [...f.querySelectorAll("[name=evtm]:checked")].map(x => x.value);
    if (!tms.length) return toast("Choisis au moins une équipe.");
    const type = val("evType"), base = { type, title: val("evTitle"), start_time: val("evS"), end_time: val("evE"), place: val("evPlace"), created_by: me.id };
    let dates = [val("evDate")];
    const rep = document.getElementById("evRepeat");
    if (type === "train" && rep && rep.checked) { const until = val("evUntil"); dates = []; for (let d = val("evDate"); d <= until && dates.length < 60; d = addDays(d, 7)) dates.push(d); }
    const evs = await q(sb.from("events").insert(dates.map(date => ({ ...base, date }))).select());
    await q(sb.from("event_teams").insert(evs.flatMap(e => tms.map(team_id => ({ event_id: e.id, team_id })))).select());
    if (type === "comp") {
      const [tr] = await q(sb.from("trips").insert({ event_id: evs[0].id, transport: val("trTransport"), depart_place: val("trPlace"), depart_time: val("trTime") || null, return_time: val("trRet"), contact: val("trContact") }).select());
      await q(sb.from("trip_items").insert(DEFAULT_ITEMS.map((label, position) => ({ trip_id: tr.id, label, position }))).select());
      if (val("trTime")) await q(sb.from("trip_steps").insert({ trip_id: tr.id, time: val("trTime"), label: "Départ" }).select());
    }
    await loadAll(); S.filter = "all"; go("planning"); toast(dates.length > 1 ? `${dates.length} entraînements ajoutés` : "Ajouté au planning");
  });

  form("tripForm", async () => {
    const id = S.editTrip;
    const [row] = await q(sb.from("trips").update({ depart_time: val("tfTime") || null, return_time: val("tfRet"), depart_place: val("tfPlace"), transport: val("tfTransport"), contact: val("tfContact") }).eq("id", id).select());
    D.trips = tripList().map(t => t.id === id ? row : t); S.editTrip = null; render(0); toast("Déplacement mis à jour");
  });
  form("addstep", async () => {
    const h = val("stH"), l = val("stL"); if (!h || !l) return toast("Indique l'heure et l'étape.");
    const [row] = await q(sb.from("trip_steps").insert({ trip_id: S.view.id, time: h, label: l }).select()); D.steps.push(row);
    document.getElementById("stL").value = ""; render(0); toast("Étape ajoutée");
  });
  form("addbring", async () => {
    const v = val("brTxt"); if (!v) return;
    const pos = itemsOf(S.view.id).length;
    const [row] = await q(sb.from("trip_items").insert({ trip_id: S.view.id, label: v, position: pos }).select()); D.items.push(row);
    document.getElementById("brTxt").value = ""; render(0); toast("Ajouté à la liste de tous les athlètes");
  });

  const mr = document.getElementById("mRole");
  if (mr) mr.onchange = () => { S.mRole = mr.value; S.mKids = [...$app.querySelectorAll("[name=mkid]:checked")].map(x => x.value); render(0); };
  form("memberForm", async f => {
    const id = S.view.id, role = val("mRole");
    const upd = { full_name: val("mName"), role, team_id: role === "athlete" ? (val("mTeam") || null) : null, title: role === "bureau" ? val("mTitle") : null };
    if (role === "athlete" && !upd.team_id) return toast("Choisis l'équipe de l'athlète.");
    const [row] = await q(sb.from("profiles").update(upd).eq("id", id).select("id,full_name,role,team_id,title"));
    D.P[id] = row;
    if (role === "parent") {
      const kids = [...f.querySelectorAll("[name=mkid]:checked")].map(x => x.value);
      await q(sb.from("parent_links").delete().eq("parent_id", id).select());
      if (kids.length) await q(sb.from("parent_links").insert(kids.map(a => ({ parent_id: id, athlete_id: a }))).select());
      D.links = D.links.filter(l => l.parent_id !== id).concat(kids.map(a => ({ parent_id: id, athlete_id: a })));
    }
    S.mRole = null; S.mKids = null; go("bureau"); toast("Fiche enregistrée");
  });

  form("nameForm", async () => {
    const [row] = await q(sb.from("profiles").update({ full_name: val("accName") }).eq("id", me.id).select("id,full_name,role,team_id,title"));
    me = Object.assign(me, row); D.P[me.id] = me; render(0); toast("Nom enregistré");
  });
  form("passForm", async () => {
    const { error } = await sb.auth.updateUser({ password: document.getElementById("accPass").value });
    if (error) return toast(frError(error)); document.getElementById("accPass").value = ""; toast("Mot de passe changé");
  });
  const lo = document.getElementById("logout"); if (lo) lo.onclick = () => sb.auth.signOut();
  bindInstall();
}

/* Remet les données à jour quand on revient sur l'app */
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && D && me && me.role !== "pending") reload(); });

/* Service worker : rend l'app installable et utilisable hors ligne */
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));

boot();
