/* Pau Cheerleading : application du club
   Données partagées via Supabase (comptes, planning, tchats, déplacements, documents). */
"use strict";

const CFG = window.PAU_CONFIG || {};
const $app = document.getElementById("app");
// Petit œil pour afficher / masquer les mots de passe (ajouté automatiquement à chaque champ)
const EYE_ON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19C5 19 1 12 1 12a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.7 9.7 0 0 1 12 4c7 0 11 8 11 8a18.6 18.6 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M1 1l22 22"/></svg>';
function addEyes(root) {
  root.querySelectorAll('input[type="password"]:not([data-eyed])').forEach(inp => {
    inp.dataset.eyed = "1";
    const wrap = document.createElement("span");
    wrap.className = "pw-wrap";
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    const b = document.createElement("button");
    b.type = "button"; b.className = "pw-eye"; b.innerHTML = EYE_ON;
    b.setAttribute("aria-label", "Afficher le mot de passe"); b.title = "Afficher le mot de passe";
    b.onclick = e => {
      e.preventDefault();
      const show = inp.type === "password";
      inp.type = show ? "text" : "password";
      b.innerHTML = show ? EYE_OFF : EYE_ON;
      const t = show ? "Masquer le mot de passe" : "Afficher le mot de passe";
      b.setAttribute("aria-label", t); b.title = t;
      inp.focus();
    };
    wrap.appendChild(b);
  });
}
new MutationObserver(() => addEyes($app)).observe($app, { childList: true, subtree: true });
const BUCKET = "club-files";
// Documents obligatoires pour chaque athlète (comptent pour « dossier complet »)
const DOC_TYPES = ["Licence FFFA", "Certificat médical", "Autorisation parentale", "Fiche sanitaire", "Droit à l'image"];
// Toutes les catégories proposées, par rubrique
const DOC_GROUPS = [
  ["Club", ["Licence FFFA", "Autorisation parentale", "Droit à l'image"]],
  ["Santé", ["Certificat médical", "Fiche sanitaire", "Carte Vitale", "Mutuelle"]],
  ["Identité et voyage", ["Carte d'identité", "Passeport", "Autorisation de sortie du territoire"]],
  ["Autres", ["Autre document"]],
];
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
function toast(msg, ms = 2600) {
  const t = document.getElementById("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, ms);
}
function fail(e, msg) {
  console.error(e);
  // Le détail technique aide à comprendre le problème (à copier au responsable de l'app)
  const d = e && (e.message || e.details || e.hint || e.code) ? String(e.message || e.details || e.hint || e.code).slice(0, 160) : "";
  toast((msg || "Une erreur est survenue. Vérifie ta connexion et réessaie.") + (d ? " Détail : " + d : ""), d ? 9000 : 2600);
}

const I = {
  check1: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  check2: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12.5L6.5 17 16 7.5M11 15.5l1.5 1.5L22 7.5"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
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
let S = { tab: "home", view: null, filter: "mine", limit: 40 };
let recovery = false;
let installEvt = null;
const urlCache = {};

const P = id => (D && D.P[id]) || { id, full_name: "Ancien membre", role: "pending" };
const T = id => (D.allTeams || D.teams).find(t => t.id === id) || { id, name: id, color: "#888" };
// Équipes proposées dans une liste : celles de la saison, plus l'équipe actuelle si elle est en pause
const teamsFor = cur => (D.allTeams || D.teams).filter(t => t.active !== false || t.id === cur);
const isBureau = () => me && me.role === "bureau";
// Peut créer, modifier et supprimer les événements et les déplacements
const canPlan = () => isBureau() || !!(me && me.can_plan && me.role !== "pending");
const planTeams = () => canPlan() ? D.teams.map(t => t.id) : myTeams();

// Athlète : rôle athlète, ou membre du bureau / coach qui pratique aussi dans une équipe
const isAth = p => !!p && (p.role === "athlete" || ((p.role === "bureau" || p.role === "coach") && !!p.team_id));
function childrenOf(pid) { return D.links.filter(l => l.parent_id === pid).map(l => P(l.athlete_id)).filter(isAth); }
function parentsOf(aid) { return D.links.filter(l => l.athlete_id === aid).map(l => P(l.parent_id)); }
function myTeams() {
  if (isBureau()) return D.teams.map(t => t.id);
  if (me.role === "athlete") return me.team_id ? [me.team_id] : [];
  if (me.role === "coach") return [...new Set([...coachTeamsOf(me.id), ...(me.team_id ? [me.team_id] : [])])].sort((a, b) => T(a).position - T(b).position);
  return [...new Set(childrenOf(me.id).map(c => c.team_id).filter(Boolean))].sort((a, b) => T(a).position - T(b).position);
}
function coachTeamsOf(id) { return (D.coachTeams || []).filter(c => c.coach_id === id).map(c => c.team_id).sort((a, b) => T(a).position - T(b).position); }
// Mes propres équipes (la mienne, celles que j'entraîne, celles de mes enfants), pour le planning par défaut
function ownTeams() {
  const s = new Set();
  if (isAth(me)) s.add(me.team_id);
  coachTeamsOf(me.id).forEach(t => s.add(t));
  childrenOf(me.id).forEach(c => c.team_id && s.add(c.team_id));
  return [...s].sort((a, b) => T(a).position - T(b).position);
}
// Équipes affichées par défaut : les miennes si j'en ai, sinon toutes celles que je vois
function defaultTeams() { const all = planTeams(), own = ownTeams().filter(t => all.includes(t)); return own.length ? own : all; }
const TEAM_LIST = [["lionceaux", "Lionceaux"], ["tigrous", "Tigrous"], ["tigroux", "Tigroux"], ["servals", "Servals"], ["cougars", "Cougars"], ["panthers", "Panthers"], ["pom", "Pom"]];
function myAthletes() { return [...(isAth(me) ? [me] : []), ...childrenOf(me.id)]; }
function childrenIn(team) { return me.role === "parent" ? childrenOf(me.id).filter(c => c.team_id === team) : []; }
function athletes() { return Object.values(D.P).filter(isAth).sort((a, b) => a.full_name.localeCompare(b.full_name)); }
function roleLabel(u) {
  const ath = u.role !== "athlete" && isAth(u) ? " · athlète " + T(u.team_id).name : "";
  if (u.role === "bureau") return (u.title ? u.title + " · " : "") + "Bureau" + ath;
  if (u.role === "athlete") return "Athlète" + (u.team_id ? " · " + T(u.team_id).name : "");
  if (u.role === "coach") { const t = coachTeamsOf(u.id); return "Coach" + (t.length ? " · " + t.map(x => T(x).name).join(", ") : "") + ath; }
  if (u.role === "parent") { const c = childrenOf(u.id); return c.length ? "Parent de " + c.map(x => first(x.full_name)).join(", ") : "Parent"; }
  return "En attente de validation";
}
function roleLabelFull(u) { return roleLabel(u) + (u.can_plan && u.role !== "bureau" && u.role !== "pending" ? " · gère le planning" : ""); }
const teamChip = id => { const t = T(id); return `<span class="chip" style="padding:3px 9px;font-size:12px"><span class="dot" style="background:${t.color}"></span>${esc(t.name)}</span>`; };

/* Conversations */
const dmPair = other => [me.id, other].sort();
function convOf(m) { return m.team_id ? "team:" + m.team_id : "dm:" + (m.dm_a === me.id ? m.dm_b : m.dm_a); }
// Préférences de chacun : conversation archivée, ou vidée « pour moi »
const prefOf = key => (D.prefs || []).find(p => p.user_id === me.id && p.conv === srvConv(key)) || {};
const clearedAt = key => prefOf(key).cleared_at ? tms(prefOf(key).cleared_at) : 0;
function msgsOf(key) { const c = clearedAt(key), h = prefOf(key).hidden || []; return D.msgs.filter(m => convOf(m) === key && (!c || tms(m.created_at) > c) && !h.includes(m.id)).sort((a, b) => a.created_at.localeCompare(b.created_at)); }
function isArchived(key) { const a = prefOf(key).archived_at; if (!a) return false; const l = lastOf(key); return !l || tms(l.created_at) <= tms(a); }
const canWipe = key => key.startsWith("dm:") || isBureau() || (me.role === "coach" && coachTeamsOf(me.id).includes(key.slice(5)));
async function savePref(key, patch) {
  const cur = prefOf(key), row = { user_id: me.id, conv: srvConv(key), archived_at: cur.archived_at || null, cleared_at: cur.cleared_at || null, ...patch };
  if (cur.hidden && cur.hidden.length && !("hidden" in patch)) row.hidden = cur.hidden;
  const [res] = await q(sb.from("chat_prefs").upsert(row).select());
  D.prefs = (D.prefs || []).filter(p => !(p.user_id === me.id && p.conv === row.conv)).concat([res || row]);
}
function readMap() { return store.get("pau-read-" + me.id, {}); }
// Lectures enregistrées sur le serveur (pour « Vu » et « Lu par… »)
const srvConv = key => key.startsWith("dm:") ? "dm:" + dmPair(key.slice(3)).join("_") : key;
const tms = t => new Date(t).getTime() || 0;
const readRow = (uid, key) => (D.reads || []).find(r => r.user_id === uid && r.conv === srvConv(key));
function setReadRow(row) {
  if (!D.reads) D.reads = [];
  const i = D.reads.findIndex(r => r.user_id === row.user_id && r.conv === row.conv);
  if (i < 0) D.reads.push(row); else if (tms(row.read_at) > tms(D.reads[i].read_at)) D.reads[i] = row;
}
function markRead(key) {
  const now = new Date().toISOString(), r = readMap(); r[key] = now; store.set("pau-read-" + me.id, r);
  // On prévient le serveur seulement s'il y a un message plus récent que la dernière lecture
  const mine = readRow(me.id, key), last = msgsOf(key).filter(m => m.sender_id !== me.id).pop();
  if (last && (!mine || tms(last.created_at) > tms(mine.read_at))) {
    setReadRow({ user_id: me.id, conv: srvConv(key), read_at: now });
    sb.rpc("mark_read", { c: srvConv(key) }).then(() => {}, () => {});
  }
}
function unreadIn(key) {
  if (isArchived(key)) return 0;
  const loc = tms(readMap()[key] || 0), srv = readRow(me.id, key), r = Math.max(loc, srv ? tms(srv.read_at) : 0);
  return msgsOf(key).filter(m => m.sender_id !== me.id && tms(m.created_at) > r).length;
}
// Qui a lu ce message (hors l'auteur)
function readersOf(key, m) {
  const c = srvConv(key);
  return (D.reads || []).filter(r => r.conv === c && r.user_id !== m.sender_id && tms(r.read_at) >= tms(m.created_at)).map(r => r.user_id);
}
function seenTag(key, m) {
  const who = readersOf(key, m);
  if (key.startsWith("dm:")) return who.length ? `<span class="seen ok" title="Vu">${I.check2} Vu</span>` : `<span class="seen" title="Envoyé">${I.check1} Envoyé</span>`;
  if (!who.length) return `<span class="seen">${I.check1} Envoyé</span>`;
  return `<button class="seen ok" data-readers="${m.id}">${I.check2} Lu par ${who.length}</button>`;
}
// Personnes à qui je peux écrire en privé
function dmPartners() {
  const all = Object.values(D.P).filter(p => p.id !== me.id && p.role !== "pending" && !p.managed);
  if (isBureau()) return all;
  const mine = myTeams();
  return all.filter(p => {
    if (p.role === "bureau") return true;
    if (p.role === "coach") return coachTeamsOf(p.id).some(t => mine.includes(t));
    if (me.role === "coach") {
      if (isAth(p) && mine.includes(p.team_id)) return true;
      if (p.role === "athlete") return false;
      if (p.role === "parent") return childrenOf(p.id).some(c => mine.includes(c.team_id));
    }
    return false;
  });
}
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

/* ============ Notifications sur le téléphone ============ */
const pushOk = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
const b64u = s => { const p = "=".repeat((4 - s.length % 4) % 4), r = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(r, c => c.charCodeAt(0)); };
async function checkPush() {
  if (!pushOk()) return;
  try { const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription(); const was = S.pushSub; S.pushSub = !!sub && Notification.permission === "granted";
    // Abonnement à jour pour ce compte
    if (sub && S.pushSub) { const j = sub.toJSON(); sb.from("push_subscriptions").upsert({ endpoint: j.endpoint, user_id: me.id, p256dh: j.keys.p256dh, auth: j.keys.auth }).then(() => {}, () => {}); }
    if (was !== S.pushSub) render(0); } catch (e) {}
}
async function enablePush() {
  if (!pushOk()) return toast(isIos() ? "Ajoute d'abord l'appli à l'écran d'accueil (bouton Partager, puis « Sur l'écran d'accueil »), et ouvre-la depuis là." : "Ce navigateur ne gère pas les notifications.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return toast("Notifications refusées. Tu peux les autoriser dans les réglages du téléphone.");
  let res; try { res = await fetch(CFG.url + "/functions/v1/notify", { headers: { Authorization: "Bearer " + ((session && session.access_token) || CFG.anonKey), apikey: CFG.anonKey } }); } catch (e) { throw new Error("Pas de réponse de la fonction « notify » : vérifie qu'elle existe et que « Verify JWT » est désactivé."); }
  const r = await res.json().catch(() => ({}));
  if (!r.publicKey) throw new Error(
    res.status === 404 ? "La fonction « notify » n'existe pas dans Supabase (vérifie son nom, en minuscules)."
    : res.status === 401 ? "La fonction « notify » refuse l'accès : désactive « Verify JWT » dans ses réglages."
    : r.error && /notify_config/.test(r.error) ? "Il manque la mise à jour 18 dans la base (SQL Editor)."
    : "Réponse inattendue de la fonction « notify » (code " + res.status + (r.error || r.message || r.msg ? " : " + (r.error || r.message || r.msg) : "") + ").");
  const publicKey = r.publicKey;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(publicKey) });
  const j = sub.toJSON();
  await q(sb.from("push_subscriptions").upsert({ endpoint: j.endpoint, user_id: me.id, p256dh: j.keys.p256dh, auth: j.keys.auth }).select());
  S.pushSub = true; render(0); toast("Notifications activées sur ce téléphone 🔔");
}
async function disablePush() {
  try { const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
    if (sub) { await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); } } catch (e) {}
  S.pushSub = false;
}
function pushCard(home) {
  if (home && (S.pushSub || store.get("pau-push-later", false) || (pushOk() && Notification.permission === "denied"))) return "";
  if (home && !pushOk() && !isIos()) return "";
  const what = isBureau() ? "les nouveaux messages et les comptes à valider" : me.role === "coach" ? "les nouveaux messages et les changements d'équipe à valider" : "les nouveaux messages des tchats";
  if (S.pushSub) return `<div class="card stack"><h2>🔔 Notifications</h2><span class="muted" style="font-size:13.5px">Activées sur ce téléphone : tu es prévenu·e pour ${what}.</span>
    <button type="button" class="btn small ghost" data-pushoff style="align-self:flex-start">Désactiver sur ce téléphone</button></div>`;
  return `<div class="card stack" style="border-color:var(--gold)"><h2>🔔 Recevoir les notifications</h2>
    <span class="muted" style="font-size:13.5px">Sois prévenu·e sur ce téléphone pour ${what}, même quand l'appli est fermée.</span>
    ${isIos() && !standalone() ? `<span style="font-size:13.5px">Sur iPhone : touche <b>Partager</b> puis <b>« Sur l'écran d'accueil »</b>, ouvre l'appli depuis l'icône, puis reviens ici.</span>` : ""}
    ${pushOk() && Notification.permission === "denied" ? `<span style="font-size:13.5px">Les notifications sont bloquées pour ce site : autorise-les dans les réglages du téléphone ou du navigateur.</span>` : ""}
    <div class="row" style="gap:6px;flex-wrap:wrap"><button type="button" class="btn small" data-pushon>Activer les notifications</button>${home ? `<button type="button" class="btn small ghost" data-pushlater>Plus tard</button>` : ""}</div></div>`;
}
// Ouvrir la bonne page depuis une notification (#chat=…, #bureau, #home)
function openFromHash() {
  const h = decodeURIComponent((location.hash || "").slice(1)); if (!h || !me || !D) return;
  if (/^(access_token|error|type)=/.test(h)) return;
  history.replaceState(null, "", location.pathname + location.search);
  if (h.startsWith("chat=")) go("chats", { kind: "conv", key: h.slice(5) });
  else if (h === "bureau" && isBureau()) go("bureau");
  else if (h === "home") go("home");
}
function setBadge() {
  try { if (!navigator.setAppBadge || !D) return;
    const n = totalUnread() + (isBureau() ? Object.values(D.P).filter(p => p.id !== me.id && p.role === "pending" && !p.managed).length + (D.linkReqs || []).length : 0) + reqsToDecide().length;
    n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch (e) {}
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
      if (me.role === "pending") { D = null; render(); sb.rpc("announce_signup").then(() => {}, () => {}); return; }
      await loadAll();
      subscribe();
      render();
      openFromHash(); checkPush();
    } catch (e) { fail(e, "Impossible de charger les données."); $app.innerHTML = `<div class="loading pad">Impossible de charger les données. <button class="btn small" onclick="location.reload()">Réessayer</button></div>`; }
    finally { starting = null; }
  })();
  return starting;
}

async function q(promise) { const { data, error } = await promise; if (error) throw error; return data || []; }
async function loadAll() {
  const since = addDays(todayIso(), -1);
  const [teams, profs, links, events, evTeams, trips, steps, legs, items, presence, packed, docs, msgs, coachTeams, attendance, news, privs, teamReqs, reads, linkReqs, prefs, boards, shifts] = await Promise.all([
    q(sb.from("teams").select("*").order("position")),
    q(sb.from("profiles").select("*")),
    q(sb.from("parent_links").select("*")),
    q(sb.from("events").select("*").gte("date", since).order("date").order("start_time").limit(3000)),
    q(sb.from("event_teams").select("*").limit(10000)),
    q(sb.from("trips").select("*")),
    q(sb.from("trip_steps").select("*").order("time")),
    q(sb.from("trip_legs").select("*")).catch(() => []),
    q(sb.from("trip_items").select("*").order("position")),
    q(sb.from("trip_presence").select("*")),
    q(sb.from("trip_packed").select("*")),
    q(sb.from("documents").select("*").order("created_at")),
    q(sb.from("messages").select("*").order("created_at", { ascending: false }).limit(600)),
    q(sb.from("coach_teams").select("*")).catch(() => []),
    q(sb.from("attendance").select("*").gte("updated_at", addDays(todayIso(), -120))).catch(() => []),
    q(sb.from("news").select("*").order("created_at", { ascending: false }).limit(60)).catch(() => []),
    q(sb.from("profile_private").select("*")).catch(() => []),
    q(sb.from("team_requests").select("*").order("created_at", { ascending: false }).limit(300)).catch(() => []),
    q(sb.from("chat_reads").select("*")).catch(() => []),
    q(sb.from("link_requests").select("*").eq("status", "pending")).catch(() => []),
    q(sb.from("chat_prefs").select("*")).catch(() => []),
    q(sb.from("shift_boards").select("*").gte("end_date", addDays(todayIso(), -30))).catch(() => []),
    q(sb.from("shift_signups").select("*").gte("day", addDays(todayIso(), -30))).catch(() => []),
  ]);
  const Pm = {}; profs.forEach(p => Pm[p.id] = p); Pm[me.id] = Object.assign(Pm[me.id] || {}, me);
  const evT = {}; evTeams.forEach(x => (evT[x.event_id] = evT[x.event_id] || []).push(x.team_id));
  events.forEach(e => e.teams = (evT[e.id] || []).sort((a, b) => (teams.find(t => t.id === a) || {}).position - (teams.find(t => t.id === b) || {}).position));
  D = { teams: teams.filter(t => t.active !== false), allTeams: teams, P: Pm, links, events, trips, steps, legs, items, presence, packed, docs, msgs, coachTeams, attendance, news, sum: {}, priv: Object.fromEntries(privs.map(x => [x.id, x])), teamReqs, reads, linkReqs, prefs, boards, shifts };
  await loadSummary();
}
// Nombre de présents par événement (tout le monde est présent sauf absence déclarée)
async function loadSummary(ids) {
  const today = todayIso(), until = addDays(today, 70);
  ids = ids || D.events.filter(e => e.date >= today && e.date <= until).slice(0, 500).map(e => e.id);
  if (!ids.length) return;
  try { (await q(sb.rpc("attendance_summary", { ids }))).forEach(r => D.sum[r.event_id] = r); } catch (e) { /* base pas encore à jour */ }
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
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, ({ old: o }) => {
      if (!D || !o || !o.id || !D.msgs.some(x => x.id === o.id)) return;
      D.msgs = D.msgs.filter(x => x.id !== o.id); render(S.tab === "chats" && S.view && S.view.kind === "conv");
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "chat_reads" }, ({ new: r }) => {
      if (!D || !r || !r.conv) return;
      setReadRow(r);
      const open = S.tab === "chats" && S.view && S.view.kind === "conv" && srvConv(S.view.key) === r.conv;
      if (open) render(true);
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

  const tabs = [["home", "Accueil", I.home], ["planning", "Planning", I.cal], ["chats", "Tchats", I.chat], ["trips", "Trajets", I.bus], ["docs", "Documents", I.doc]];
  let title = "", body = "", back = null, composer = "";
  const v = S.view;
  try {
    if (S.tab === "account") { title = "Mon compte"; body = accountView(); back = () => go("home"); }
    if (S.tab === "home") { title = "Pau Cheerleading"; body = homeView(); }
    if (S.tab === "planning") {
      if (v && v.kind === "addEvent" && canPlan()) { title = "Ajouter au planning"; body = addEventView(); back = () => go("planning"); }
      else if (v && v.kind === "roll") { title = "Appel"; body = rollView(v.id); back = () => go("planning"); }
      else if (v && v.kind === "teams") { title = "Gérer les équipes"; body = teamsManageView(); back = () => go("planning"); }
      else if (v && v.kind === "boards") { title = "Permanences"; body = boardsView(); back = () => go("planning"); }
      else if (v && v.kind === "board") { title = "Permanence"; body = boardView(v.id); back = () => go("planning", { kind: "boards" }); }
      else if (v && v.kind === "boardForm" && canPlan()) { title = v.id ? "Modifier la permanence" : "Nouvelle permanence"; body = boardFormView(v.id); back = () => v.id ? go("planning", { kind: "board", id: v.id }) : go("planning", { kind: "boards" }); }
      else if (v && v.kind === "editEvent" && canPlan()) { title = "Modifier"; body = editEventView(v.id); back = () => go("planning"); }
      else { title = "Planning"; body = planningView(); }
    }
    if (S.tab === "chats") {
      if (v && v.kind === "conv") { const r = convView(v.key); title = r.title; body = r.body; composer = r.composer; back = () => go("chats"); }
      else if (v && v.kind === "contacts") { title = "Écrire à…"; body = contactsView(); back = () => go("chats"); }
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
      else if (v && v.kind === "dups") { title = "Enfants en double"; body = dupsView(); back = () => go("bureau"); }
      else { title = "Espace bureau"; body = bureauView(); back = () => go("home"); }
    }
  } catch (e) { console.error(e); body = `<div class="empty">Cette page n'a pas pu s'afficher.</div>`; }

  const un = totalUnread();
  $app.innerHTML = `
    ${navigator.onLine ? "" : `<div class="offline">Pas de connexion internet : les nouveautés s'afficheront au retour du réseau.</div>`}
    <header class="top pad">
      ${back ? `<button class="back" id="back" aria-label="Retour">‹</button>` : `<img class="hlogo" src="icons/logo.webp" alt="">`}
      <h1>${esc(title)}</h1>
      <button class="who" id="who" title="Mon compte">${avatar(me, 26)}${esc(first(me.full_name) || "Mon compte")}</button>
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
  bind(); setBadge();
  fillImages();
}

/* ============ Connexion ============ */
function teamOptions(sel) { return (S.signupTeams || TEAM_LIST).map(([id, name]) => `<option value="${id}" ${sel === id ? "selected" : ""}>${esc(name)}</option>`).join(""); }
function readKids() { return [...$app.querySelectorAll("[data-kid]")].map(c => ({ first: c.querySelector("[name=kFirst]").value.trim(), last: c.querySelector("[name=kLast]").value.trim(), birth: c.querySelector("[name=kBirth]").value, team: c.querySelector("[name=kTeam]").value, gender: c.querySelector("[name=kGender]").value, consent: c.querySelector("[name=kConsent]").value })); }
function authView() {
  const m = S.auth || "login";
  const head = `<div class="brand"><img src="icons/logo.webp" alt="Logo Pau Cheerleading"><div class="eyebrow">Application du club</div><div class="logo">Pau<br><span>Cheerleading</span></div></div>`;
  if (m === "signup") return `<div class="login pad">${head}
    <form id="signup" class="authbox"><h2>Créer mon compte</h2>
      <div class="field">Je suis<div class="chips">${[["parent", "Parent"], ["athlete", "Athlète"], ["other", "Coach ou bureau"]].map(([v, l]) => `<label class="chip"><input type="radio" name="suKind" value="${v}" ${S.suKind === v ? "checked" : ""}> ${l}</label>`).join("")}</div></div>
      <div class="grid2"><label class="field">Prénom<input id="suFirst" autocomplete="given-name" required></label><label class="field">Nom<input id="suLast" autocomplete="family-name" required></label></div>
      <div class="field">Sexe${genderPick("suGender", S.suGender)}</div>
      <label class="field">Téléphone<input id="suPhone" type="tel" autocomplete="tel" placeholder="06 12 34 56 78" required></label>
      ${consentPick("suConsent", S.suConsent, "de mon image")}
      ${S.suKind === "athlete" ? `<div class="grid2"><label class="field">Date de naissance<input id="suBirth" type="date" required></label><label class="field">Équipe<select id="suTeam" required><option value="">Choisir…</option>${teamOptions()}</select></label></div>` : ""}
      ${S.suKind === "parent" ? `<div class="stack" style="gap:8px"><div class="eyebrow">Mes enfants inscrits au club</div>
        <p class="muted" style="margin:0;font-size:13px">Si l'autre parent a déjà inscrit l'enfant, écris exactement le même prénom, nom et date de naissance : vous serez reliés au même enfant, avec les mêmes droits.</p>
        ${(S.suKids || [{}]).map((k, i) => `<div class="card stack" style="gap:8px;padding:10px 12px" data-kid="${i}">
          <div class="row" style="justify-content:space-between"><b style="font-size:14px">Enfant ${i + 1}</b>${i > 0 ? `<button type="button" class="link" data-delkid="${i}">Retirer</button>` : ""}</div>
          <div class="grid2"><label class="field">Prénom<input name="kFirst" value="${esc(k.first || "")}" required></label><label class="field">Nom<input name="kLast" value="${esc(k.last || "")}" required></label></div>
          <div class="grid2"><label class="field">Date de naissance<input name="kBirth" type="date" value="${esc(k.birth || "")}" required></label><label class="field">Équipe<select name="kTeam" required><option value="">Choisir…</option>${teamOptions(k.team)}</select></label></div>
          <label class="field">Publication de son image (réseaux, site, presse)<select name="kConsent" required><option value="">Choisir…</option><option value="true" ${k.consent === "true" ? "selected" : ""}>J'accepte</option><option value="false" ${k.consent === "false" ? "selected" : ""}>Je refuse</option></select></label>
          <label class="field">Sexe<select name="kGender" required><option value="">…</option><option value="F" ${k.gender === "F" ? "selected" : ""}>👧 Fille</option><option value="H" ${k.gender === "H" ? "selected" : ""}>👦 Garçon</option><option value="N" ${k.gender === "N" ? "selected" : ""}>🧒 Sans genre</option></select></label></div>`).join("")}
        <button type="button" class="btn ghost small" data-addkid style="align-self:flex-start">＋ Ajouter un autre enfant</button>
        <label class="check card" style="padding:10px 12px"><input type="checkbox" id="suLegal" ${S.suLegal ? "checked" : ""}><span><b>Je suis responsable légal</b> de ces enfants</span></label></div>` : ""}
      ${S.suKind === "parent" || S.suKind === "athlete" ? `<div class="stack" style="gap:8px"><div class="eyebrow">Personne à contacter en cas de problème</div>
        <p class="muted" style="margin:0;font-size:13px">${S.suKind === "parent" ? "Une autre personne que toi (grand-parent, autre parent…), si on n'arrive pas à te joindre." : "Un parent ou un proche à prévenir en cas d'accident."}</p>
        <div class="grid2"><label class="field">Nom<input id="suEmName" required></label><label class="field">Téléphone<input id="suEmPhone" type="tel" required></label></div></div>` : ""}
      <label class="field">E-mail<input id="suEmail" type="email" autocomplete="email" required></label>
      <label class="field">Mot de passe (8 caractères minimum)<input id="suPass" type="password" autocomplete="new-password" minlength="8" required></label>
      <div class="err" id="authErr" hidden></div>
      <button class="btn">Créer mon compte</button>
      <p class="muted" style="margin:0;font-size:13px">Après la création, un membre du bureau vérifie et valide ton compte.</p>
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
    <span class="muted">${me && me.wish === "parent" ? "Un membre du bureau va vérifier tes enfants et leur équipe. Tu pourras ensuite voir leur planning, leurs tchats et indiquer leurs absences." : "Un membre du bureau va vérifier ton compte et ton équipe. Tu pourras ensuite voir le planning et les tchats."}</span>
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
  if (su && !S.signupTeams) sb.from("teams").select("*").order("position").then(({ data }) => { if (data && data.length) { S.signupTeams = data.filter(t => t.active !== false).map(t => [t.id, t.name]); } });
  $app.querySelectorAll("[name=suKind]").forEach(r => r.onchange = () => { keepSignup(); S.suKind = r.value; render(); });
  const keepSignup = () => { const k = readKids(); S.suKids = k.length ? k : (S.suKids || [{}]); const gg = $app.querySelector("[name=suGender]:checked"); if (gg) S.suGender = gg.value; const cc = consentVal($app, "suConsent"); if (cc !== null) S.suConsent = cc; const lg = document.getElementById("suLegal"); if (lg) S.suLegal = lg.checked;
    S.suVals = Object.fromEntries(["suFirst", "suLast", "suEmail", "suBirth", "suTeam", "suPhone", "suEmName", "suEmPhone"].map(id => [id, (document.getElementById(id) || {}).value || ""])); };
  if (su && S.suVals) { for (const [id, v] of Object.entries(S.suVals)) { const el = document.getElementById(id); if (el && v) el.value = v; } }
  const ak = $app.querySelector("[data-addkid]"); if (ak) ak.onclick = () => { keepSignup(); S.suKids.push({ last: (S.suKids[0] || {}).last || "" }); render(); };
  $app.querySelectorAll("[data-delkid]").forEach(b => b.onclick = () => { keepSignup(); S.suKids.splice(+b.dataset.delkid, 1); render(); });
  if (su) su.onsubmit = async ev => { ev.preventDefault();
    if (!S.suKind) return authErr("Indique si tu es parent, athlète, coach ou membre du bureau.");
    const gs = $app.querySelector("[name=suGender]:checked");
    if (!gs) return authErr("Indique si tu es une femme ou un homme.");
    if (consentVal($app, "suConsent") === null) return authErr("Indique si tu acceptes ou refuses la publication de ton image.");
    const meta = { full_name: (val("suFirst") + " " + val("suLast")).trim(), kind: S.suKind === "other" ? "" : S.suKind, gender: gs.value, phone: val("suPhone"), image_consent: consentVal($app, "suConsent") };
    if (document.getElementById("suEmName")) { meta.emergency_name = val("suEmName"); meta.emergency_phone = val("suEmPhone"); }
    if (document.getElementById("suLegal")) meta.legal = document.getElementById("suLegal").checked;
    if (S.suKind === "athlete") { meta.birth_date = val("suBirth"); meta.team = val("suTeam"); }
    if (S.suKind === "parent") meta.children = readKids().filter(k => k.first && k.last).map(k => ({ ...k, image_consent: k.consent === "" ? null : k.consent === "true", consent: undefined }));
    busy(su, true);
    const { data, error } = await sb.auth.signUp({ email: val("suEmail"), password: document.getElementById("suPass").value,
      options: { data: meta, emailRedirectTo: location.origin + location.pathname } });
    busy(su, false);
    if (error) return authErr(frError(error));
    S.suKids = null; S.suVals = null; S.suGender = null; S.suLegal = false; S.suConsent = null;
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
  const lo = document.getElementById("logout"); if (lo) lo.onclick = async () => { await disablePush(); sb.auth.signOut(); };
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
/* Changements d'équipe */
const coachesTeam = t => isBureau() || (me.role === "coach" && coachTeamsOf(me.id).includes(t));
const manageTeams = () => isBureau() ? D.teams.map(t => t.id) : me.role === "coach" ? coachTeamsOf(me.id) : [];
const reqsToDecide = () => (D.teamReqs || []).filter(r => r.status === "pending" && coachesTeam(r.to_team));
const pendingReqOf = aid => (D.teamReqs || []).find(r => r.athlete_id === aid && r.status === "pending");
function teamReqBlock(a) {
  const r = pendingReqOf(a.id);
  if (r) return `<div class="notice" style="flex-wrap:wrap">${I.user}<span style="flex:1">Demande de passage en <b>${esc(T(r.to_team).name)}</b> envoyée, en attente du coach.</span><button type="button" class="btn small ghost" data-cancelreq="${r.id}">Annuler la demande</button></div>`;
  return `<div class="field">Demander un changement d'équipe<div class="row" style="gap:6px"><select class="search" data-reqteam="${a.id}" style="flex:1;min-width:0;padding:7px 10px"><option value="">Choisir la nouvelle équipe…</option>${D.teams.filter(t => t.id !== a.team_id).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select><button type="button" class="btn small" data-sendreq="${a.id}">Demander</button></div>
    <span class="muted" style="font-size:12.5px;font-weight:400">Le coach de la nouvelle équipe accepte ou refuse.</span></div>`;
}
function reqsCard() { return teamReqsCard() + linkReqsCard(); }
function linkReqsCard() {
  const l = isBureau() ? (D.linkReqs || []).filter(r => r.status === "pending") : []; if (!l.length) return "";
  return `<div class="card stack" style="border-color:var(--gold)"><h2>Parents à relier à un enfant</h2>
    ${l.map(r => { const a = P(r.athlete_id), others = parentsOf(a.id);
      return `<div class="row" style="gap:8px;flex-wrap:wrap">${avatar(a, 32)}<span style="flex:1;min-width:140px"><b>${esc(P(r.parent_id).full_name)}</b> dit être le parent de <b>${esc(a.full_name)}</b><br><span class="muted" style="font-size:13px">${a.team_id ? esc(T(a.team_id).name) : "Sans équipe"}${a.birth_date ? " · né·e le " + fmtDate(a.birth_date + "T12:00:00") : ""}${others.length ? " · déjà relié à " + others.map(x => esc(x.full_name)).join(", ") : ""}</span></span>
      <button class="btn small" data-linkdecide="${r.id}|1">Relier</button><button class="btn small ghost" data-linkdecide="${r.id}|0">Refuser</button></div>`; }).join("")}</div>`;
}
function teamReqsCard() {
  const l = reqsToDecide(); if (!l.length) return "";
  return `<div class="card stack" style="border-color:var(--gold)"><h2>Demandes de changement d'équipe</h2>
    ${l.map(r => `<div class="row" style="gap:8px;flex-wrap:wrap">${avatar(P(r.athlete_id), 32)}<span style="flex:1;min-width:140px"><b>${esc(P(r.athlete_id).full_name)}</b><br><span class="muted" style="font-size:13px">${r.from_team ? esc(T(r.from_team).name) : "Sans équipe"} → ${esc(T(r.to_team).name)} · demandé par ${esc(first(P(r.requested_by).full_name))}</span></span>
      <button class="btn small" data-decide="${r.id}|1">Accepter</button><button class="btn small ghost" data-decide="${r.id}|0">Refuser</button></div>`).join("")}</div>`;
}
// Le coach (ou le bureau) répartit ses athlètes, par exemple au changement de saison
function teamsManageView() {
  const mine = manageTeams(), q2 = (S.tq || "").toLowerCase();
  const list = athletes().filter(a => mine.includes(a.team_id) && a.full_name.toLowerCase().includes(q2));
  return `<div class="notice">${I.user}<span>Choisis la nouvelle équipe de chaque athlète, puis touche « Enregistrer les changements ». Pratique au changement de saison.</span></div>
    ${reqsCard()}
    <input class="search" id="tq" placeholder="Rechercher un athlète…" aria-label="Rechercher">
    ${mine.map(t => { const l = list.filter(a => a.team_id === t); return l.length ? `<div class="daylabel">Équipe ${esc(T(t).name)} · ${l.length}</div><div class="list">${l.map(a => `<div class="item">${avatar(a, 36)}<span class="txt"><span class="t1">${esc(a.full_name)}</span>${a.birth_date ? `<span class="t2">né·e le ${fmtDate(a.birth_date + "T12:00:00")}</span>` : ""}</span>
      <select class="search" data-move="${a.id}" style="max-width:150px;padding:7px 10px">${teamsFor(a.team_id).map(x => `<option value="${x.id}" ${x.id === a.team_id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}<option value="">Sans équipe</option></select></div>`).join("")}</div>` : ""; }).join("") || `<div class="empty">Aucun athlète dans tes équipes.</div>`}
    <button class="btn" data-savemoves>Enregistrer les changements</button>`;
}
// Retirer un enfant ajouté par erreur
const kidWillBeDeleted = c => c.managed && parentsOf(c.id).every(x => x.id === me.id);
const removeKidBtn = c => `<button type="button" class="btn small ghost" data-askrmkid="${c.id}">${kidWillBeDeleted(c) ? "Supprimer cet enfant" : "Retirer de mon compte"}</button>`;
function removeKidConfirm(c) {
  if (S.rmKid !== c.id) return "";
  return `<div class="stack" style="gap:8px;border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:var(--surface-2)">
    <span style="font-size:13.5px">${kidWillBeDeleted(c) ? `<b>Supprimer ${esc(c.full_name)} ?</b> Sa fiche, ses absences et sa photo seront effacées.` : `<b>Retirer ${esc(c.full_name)} de ton compte ?</b> ${parentsOf(c.id).some(x => x.id !== me.id) ? "Son autre parent le garde." : "Son propre compte n'est pas supprimé."}`}</span>
    <div class="row" style="gap:8px"><button type="button" class="btn small" data-rmkid="${c.id}" style="background:#c43c3c;color:#fff">Oui, ${kidWillBeDeleted(c) ? "supprimer" : "retirer"}</button><button type="button" class="btn small ghost" data-askrmkid="">Annuler</button></div></div>`;
}
// « Mes enfants » : pour tout membre (un membre du bureau ou un coach peut aussi être parent)
function myKidsCard() {
  if (me.role === "pending") return "";
  const pend = D.links.filter(l => l.parent_id === me.id).map(l => P(l.athlete_id)).filter(c => c.role === "pending");
  const others = isBureau() ? athletes().filter(a => a.id !== me.id && !D.links.some(l => l.parent_id === me.id && l.athlete_id === a.id)) : [];
  const asked = (D.linkReqs || []).filter(r => r.parent_id === me.id && r.status === "pending");
  const mk = S.mk || {}, matches = S.kidMatches || [];
  return `<div class="card stack"><h2>${childrenOf(me.id).length ? "Ajouter un autre enfant" : "Mes enfants au club"}</h2>
    ${pend.map(c => `<div class="row" style="gap:8px;flex-wrap:wrap">${avatar(c, 32)}<span style="flex:1">${esc(c.full_name)}</span><span class="tag warn">en attente du bureau</span>${removeKidBtn(c)}</div>${removeKidConfirm(c)}`).join("")}
    ${asked.map(r => `<div class="row" style="gap:8px;flex-wrap:wrap">${avatar(P(r.athlete_id), 32)}<span style="flex:1">${esc(P(r.athlete_id).full_name)}</span><span class="tag warn">demande envoyée au bureau</span><button type="button" class="link" data-linkdecide="${r.id}|0">Annuler</button></div>`).join("")}
    <div class="grid2"><label class="field">Prénom<input id="mkFirst" value="${esc(mk.first || "")}"></label><label class="field">Nom<input id="mkLast" value="${esc(mk.last != null ? mk.last : splitName(me.full_name)[1])}"></label></div>
    <div class="grid2"><label class="field">Date de naissance<input id="mkBirth" type="date" value="${esc(mk.birth || "")}"></label><label class="field">Équipe<select id="mkTeam"><option value="">Choisir…</option>${D.teams.map(t => `<option value="${t.id}" ${mk.team === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label></div>
    <div class="field">Sexe${genderPick("mkGender", mk.gender || null, true)}</div>
    ${matches.length ? `<div class="stack" style="gap:8px;border:1px solid var(--gold);border-radius:12px;padding:10px 12px;background:var(--accent-soft)">
      <b style="font-size:14px">Cet enfant est peut-être déjà inscrit :</b>
      ${matches.map(m => `<div class="row" style="gap:8px;flex-wrap:wrap">${avatar(P(m.id).id ? P(m.id) : { full_name: m.full_name }, 32)}<span style="flex:1;min-width:140px"><b>${esc(m.full_name)}</b><br><span class="muted" style="font-size:12.5px">${m.team_id ? esc(T(m.team_id).name) : "Sans équipe"}${m.birth_date ? " · né·e le " + fmtDate(m.birth_date + "T12:00:00") : ""}</span>
        ${m.same_birth ? '<span class="tag ok">même date de naissance</span> ' : ""}${m.same_team ? '<span class="tag ok">même équipe</span>' : ""}</span>
        <button type="button" class="btn small" data-claimkid="${m.id}">C'est mon enfant</button></div>`).join("")}
      <button type="button" class="btn small ghost" data-addmykid="force" style="align-self:flex-start">Non, c'est un autre enfant : l'ajouter</button></div>`
    : `<button type="button" class="btn small" data-addmykid style="align-self:flex-start">Ajouter mon enfant</button>`}
    ${isBureau() ? "" : `<p class="muted" style="margin:0;font-size:12.5px">Le bureau valide l'ajout. Si ton enfant est déjà inscrit (par l'autre parent par exemple), l'appli te le propose.</p>`}
    ${others.length ? `<div class="field">Ou relier un athlète déjà inscrit<div class="row" style="gap:6px"><select class="search" id="mkLink" style="flex:1;min-width:0;padding:7px 10px"><option value="">Choisir…</option>${others.map(a => `<option value="${a.id}">${esc(a.full_name)}${a.team_id ? " · " + esc(T(a.team_id).name) : ""}</option>`).join("")}</select><button type="button" class="btn small" data-linkmykid>Relier</button></div></div>` : ""}
  </div>`;
}
function accountView() {
  return `<div class="card stack"><div class="row">${avatar(me, 56)}<span><b style="font-size:17px">${esc(me.full_name)}</b><br><span class="muted">${esc(roleLabel(me))}</span></span></div>
      <span class="muted" style="font-size:13.5px">${esc(myEmail)}</span>
      <div class="row" style="gap:6px">${photoBtn(me.id, me.photo_path ? "📷 Changer ma photo" : "📷 Ajouter ma photo")}</div></div>
    <form id="nameForm" class="card stack"><h2>Mes informations</h2>
      ${nameFields("acc", me.full_name)}
      <div class="field">Sexe${genderPick("accGender", PV(me.id).gender)}</div>
      ${consentPick("accConsent", PV(me.id).image_consent, "de mon image")}
      ${isBureau() ? `<label class="field">Je pratique aussi comme athlète dans l'équipe<select id="accTeam"><option value="">Non, je ne suis pas athlète</option>${teamsFor(me.team_id).map(t => `<option value="${t.id}" ${me.team_id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>` : ""}
      <label class="field">Téléphone<input id="accPhone" type="tel" value="${esc(PV(me.id).phone || "")}" placeholder="06 12 34 56 78"></label>
      ${isAth(me) ? `<div class="eyebrow">Personne à contacter en cas de problème</div>
        <div class="grid2"><label class="field">Nom<input id="accEmName" value="${esc(PV(me.id).emergency_name || "")}"></label><label class="field">Téléphone<input id="accEmPhone" type="tel" value="${esc(PV(me.id).emergency_phone || "")}"></label></div>` : ""}
      <button class="btn small" style="align-self:flex-start">Enregistrer</button></form>
    ${childrenOf(me.id).length ? childrenOf(me.id).map(c => `<form class="card stack" data-kidform="${c.id}"><div class="row" style="gap:10px">${avatar(c, 48)}<h2 style="flex:1">${esc(c.full_name)}</h2>${photoBtn(c.id)}</div>
      <span class="muted" style="font-size:13px">${c.team_id ? esc(T(c.team_id).name) : "Sans équipe"}${c.birth_date ? " · né·e le " + fmtDate(c.birth_date + "T12:00:00") : ""}</span>
      <div class="field">Sexe${genderPick("kg-" + c.id, PV(c.id).gender, true)}</div>
      ${consentPick("kc-" + c.id, PV(c.id).image_consent, "de l'image de " + esc(first(c.full_name)))}
      ${c.managed ? "" : `<label class="field">Téléphone de ${esc(first(c.full_name))}<input name="kPhone" type="tel" value="${esc(PV(c.id).phone || "")}"></label>`}
      <label class="check"><input type="checkbox" name="kLegal" ${isLegal(me.id, c.id) ? "checked" : ""}><span>Je suis <b>responsable légal</b> de ${esc(first(c.full_name))}</span></label>
      <div class="eyebrow">Personne à contacter en cas de problème</div>
      <div class="grid2"><label class="field">Nom<input name="kEmName" value="${esc(PV(c.id).emergency_name || "")}"></label><label class="field">Téléphone<input name="kEmPhone" type="tel" value="${esc(PV(c.id).emergency_phone || "")}"></label></div>
      ${c.role === "athlete" || isAth(c) ? teamReqBlock(c) : ""}
      <span class="muted" style="font-size:12.5px">Autre(s) parent(s) : ${parentsOf(c.id).filter(x => x.id !== me.id).map(x => esc(x.full_name) + (isLegal(x.id, c.id) ? " (responsable légal)" : "")).join(", ") || "aucun dans l'app"}</span>
      <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn small">Enregistrer</button>${removeKidBtn(c)}</div>${removeKidConfirm(c)}</form>`).join("") : ""}
    ${me.role === "athlete" ? `<div class="card stack"><h2>Mon équipe : ${me.team_id ? esc(T(me.team_id).name) : "aucune"}</h2>${teamReqBlock(me)}</div>` : ""}
    ${myKidsCard()}
    ${pushCard(false)}
    <form id="passForm" class="card stack"><h2>Changer de mot de passe</h2><label class="field">Nouveau mot de passe<input id="accPass" type="password" minlength="8" autocomplete="new-password" required></label><button class="btn small" style="align-self:flex-start">Changer</button></form>
    ${installCard()}
    <button class="btn ghost" id="logout">Se déconnecter</button>`;
}

/* ============ Accueil et actualités ============ */
function homeView() {
  const today = todayIso(), teams = defaultTeams();
  const next = D.events.filter(e => e.date >= today && e.teams.some(t => teams.includes(t))).slice(0, 3);
  const un = totalUnread();
  const missing = myAthletes().reduce((n, a) => n + DOC_TYPES.filter(t => !docsOf(a.id).some(d => d.doc_type === t)).length, 0);
  const pending = isBureau() ? Object.values(D.P).filter(p => p.id !== me.id && p.role === "pending" && (!p.managed || (parentsOf(p.id).length && parentsOf(p.id).every(x => x.role !== "pending")))).length : 0;
  const news = [...(D.news || [])].sort((a, b) => (b.pinned - a.pinned) || b.created_at.localeCompare(a.created_at));
  const tile = (attr, big, label, warn) => `<button class="card" ${attr} style="text-align:left;display:flex;flex-direction:column;gap:2px;${warn ? "border-color:var(--gold)" : ""}"><span style="font-family:var(--display);font-size:24px;font-weight:800;line-height:1">${big}</span><span class="muted" style="font-size:13px">${label}</span></button>`;
  return `<div class="row" style="gap:12px"><img src="icons/logo.webp" alt="" style="width:64px;height:64px;border-radius:12px"><div><div class="eyebrow">Bonjour</div><h2 style="font-size:22px">${esc(first(me.full_name) || "et bienvenue")}</h2></div></div>
    ${!PV(me.id).gender || !PV(me.id).phone || PV(me.id).image_consent == null || childrenOf(me.id).some(c => !PV(c.id).gender || !PV(c.id).emergency_phone || PV(c.id).image_consent == null) ? `<button class="card" data-tab="account" style="text-align:left;border-color:var(--gold);display:flex;flex-direction:column;gap:4px"><b>Complète ta fiche</b><span class="muted" style="font-size:13px">Indique ${me.role === "parent" ? "ton téléphone, le sexe de chaque enfant, le droit à l'image, le responsable légal et la personne à contacter en cas de problème" : "si tu es une femme ou un homme, ton téléphone et ton accord pour la publication de ton image"}.</span><span style="font-weight:700;color:var(--accent)">Compléter ›</span></button>` : ""}
    <div class="grid2">
      ${tile('data-tab="chats"', un, un > 1 ? "messages non lus" : "message non lu", un > 0)}
      ${isBureau() ? tile('data-tab="bureau"', pending, "compte" + (pending > 1 ? "s" : "") + " à valider · Espace bureau", pending > 0)
        : myAthletes().length ? tile('data-tab="docs"', missing, "document" + (missing > 1 ? "s" : "") + " à envoyer", missing > 0) : tile('data-tab="planning"', next.length, "prochains rendez-vous", false)}
    </div>
    ${isBureau() ? (() => { const nd = dupPairs().length; return `<button class="card" data-tab="bureau" style="text-align:left;display:flex;gap:12px;align-items:center;border-color:var(--gold)"><span style="color:var(--accent);width:26px;height:26px;display:flex">${I.user}</span><span style="flex:1"><b style="font-size:16px">Espace bureau</b><br><span class="muted" style="font-size:13px">Membres, comptes à valider, enfants en double${nd ? ` (<b style="color:var(--accent)">${nd}</b>)` : ""}, annonces</span></span><span style="font-size:20px;color:var(--accent)">›</span></button>`; })() : ""}
    ${pushCard(true)}
    ${reqsCard()}
    ${liveBoards().map(boardCard).join("")}
    ${next.length ? `<div class="card stack"><div class="row" style="justify-content:space-between"><h2>À venir</h2><button class="link" data-tab="planning">Tout le planning</button></div>
      ${next.map(e => `<div class="row" style="gap:10px;align-items:flex-start"><span style="width:84px;flex:none;font-size:13px;font-weight:700;text-transform:capitalize;white-space:nowrap">${fmtShort(e.date).replace(/\.$/, "")}</span>
        <span style="flex:1;min-width:0"><b>${esc(e.title)}</b> <span class="muted" style="font-size:13px">${hm(e.start_time)}</span><br>${e.teams.filter(t => teams.includes(t)).map(teamChip).join(" ")}</span></div>`).join("")}</div>` : ""}
    <div class="row" style="justify-content:space-between;margin-top:4px"><h2 style="font-size:20px">Actualités du club</h2></div>
    ${isBureau() ? `<details class="card"${S.newsOpen ? " open" : ""}><summary style="font-weight:700;cursor:pointer">＋ Publier une actualité</summary>
      <form id="newsForm" class="stack" style="margin-top:10px">
        <label class="field">Titre<input id="nwTitle" required placeholder="Ex : Bravo aux Servals, champions régionaux !"></label>
        <label class="field">Texte<textarea id="nwBody" rows="5" placeholder="Raconte la nouvelle…"></textarea></label>
        <label class="field">Photo (facultatif)<input id="nwImg" type="file" accept="image/*"></label>
        <label class="check"><input type="checkbox" id="nwPin"><span>Épingler en haut de la page</span></label>
        <p class="muted" style="margin:0;font-size:12.5px">L'actualité est visible par tous les membres du club : athlètes, parents, coachs et bureau.</p>
        <button class="btn">Publier</button></form></details>` : ""}
    ${news.map(n => `<article class="card stack" style="${n.pinned ? "border-color:var(--gold)" : ""}">
      ${n.image_path ? `<img data-path="${esc(n.image_path)}" alt="" style="width:100%;border-radius:10px;max-height:320px;object-fit:cover;background:var(--surface-2);min-height:120px">` : ""}
      <div class="row" style="gap:6px;flex-wrap:wrap">${n.pinned ? '<span class="tag comp">Épinglé</span>' : ""}<span class="muted" style="font-size:12.5px">${fmtDate(n.created_at)} · ${esc(P(n.created_by).full_name)}</span></div>
      <h2>${esc(n.title)}</h2>
      ${n.body ? `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(n.body)}</div>` : ""}
      ${isBureau() ? `<div class="row" style="gap:6px"><button class="btn small ghost" data-pinnews="${n.id}">${n.pinned ? "Désépingler" : "Épingler"}</button>${S.confirmNews === n.id ? `<button class="btn small danger" data-delnews="${n.id}">Confirmer la suppression</button>` : `<button class="btn small ghost" data-askdelnews="${n.id}">Supprimer</button>`}</div>` : ""}
    </article>`).join("") || `<div class="empty">Aucune actualité pour le moment.${isBureau() ? "<br>Publie la première avec le bouton ci-dessus." : ""}</div>`}
    ${bureauBlock()}`;
}
function bureauBlock() {
  const order = t => { const x = (t || "").toLowerCase(); return x.includes("présid") ? 0 : x.includes("vice") ? 1 : x.includes("trésor") ? 2 : x.includes("secr") ? 3 : 4; };
  const members = Object.values(D.P).filter(p => p.role === "bureau").sort((a, b) => order(a.title) - order(b.title) || a.full_name.localeCompare(b.full_name));
  if (!members.length) return "";
  return `<h2 style="font-size:20px;margin-top:6px">Le bureau du club</h2>
    <p class="muted" style="margin:0;font-size:13.5px">Pour toute question, écris directement à un membre du bureau. La conversation reste privée entre vous deux.</p>
    <div class="list">${members.map(p => `<div class="item">${avatar(p, 42)}
      <span class="txt"><span class="t1">${esc(p.full_name)}${p.id === me.id ? ' <span class="muted" style="font-weight:500">(toi)</span>' : ""}</span><span class="t2">${esc(p.title || "Membre du bureau")}</span></span>
      ${p.id !== me.id ? `<button class="btn small" data-conv="dm:${p.id}">💬 Écrire</button>` : ""}</div>`).join("")}</div>
    ${isBureau() ? `<p class="muted" style="margin:0;font-size:12.5px">La fonction de chaque membre (président, trésorière…) se règle dans sa fiche, onglet Espace bureau.</p>` : ""}`;
}

/* ============ Planning ============ */
/* ============ Permanences (ex. papiers cadeaux) ============ */
const toMin = t => { const [h, m] = (t || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
const fromMin = n => String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
const hhmm = t => hm(t).replace(":", "h");
function boardSlots(b) { const out = [], a = toMin(b.day_start), z = toMin(b.day_end); for (let t = a; t < z; t += b.slot_minutes) out.push([fromMin(t), fromMin(Math.min(t + b.slot_minutes, z))]); return out; }
function boardDays(b) { const out = []; for (let d = b.start_date; d <= b.end_date && out.length < 93; d = addDays(d, 1)) out.push(d); return out; }
const shiftsAt = (bid, day, st) => (D.shifts || []).filter(s => s.board_id === bid && s.day === day && hm(s.start_time) === st);
const myPeople = () => [me, ...childrenOf(me.id).filter(c => c.id !== me.id)];
const myShifts = b => (D.shifts || []).filter(s => s.board_id === b.id && myPeople().some(p => p.id === s.person_id)).sort((x, y) => (x.day + x.start_time).localeCompare(y.day + y.start_time));
const boardFor = b => !b.teams || !b.teams.length || isBureau() || b.teams.some(t => myTeams().includes(t));
const liveBoards = () => (D.boards || []).filter(b => b.end_date >= todayIso() && boardFor(b)).sort((a, b) => a.start_date.localeCompare(b.start_date));
function boardFree(b) { const cap = boardDays(b).filter(d => d >= todayIso()).length * boardSlots(b).length * b.capacity; const used = (D.shifts || []).filter(s => s.board_id === b.id && s.day >= todayIso()).length; return Math.max(0, cap - used); }
const boardDates = b => b.start_date === b.end_date ? fmtShort(b.start_date) : "du " + fmtShort(b.start_date) + " au " + fmtShort(b.end_date);
function boardCard(b) {
  const mine = myShifts(b), free = boardFree(b);
  return `<button class="card" data-board="${b.id}" style="text-align:left;display:flex;flex-direction:column;gap:4px;border-color:var(--gold)">
    <span class="eyebrow">🙋 Permanence</span><b style="font-size:16px">${esc(b.title)}</b>
    <span class="muted" style="font-size:13px">${boardDates(b)} · ${hhmm(b.day_start)} – ${hhmm(b.day_end)}${b.place ? " · " + esc(b.place) : ""}</span>
    <span class="row" style="gap:6px;flex-wrap:wrap">${mine.length ? `<span class="tag ok">${mine.length} créneau${mine.length > 1 ? "x" : ""} réservé${mine.length > 1 ? "s" : ""}</span>` : `<span class="tag warn">Pas encore inscrit·e</span>`}<span class="muted" style="font-size:12.5px">${free} place${free > 1 ? "s" : ""} libre${free > 1 ? "s" : ""}</span></span>
    <span style="font-weight:700;color:var(--accent)">Choisir un créneau ›</span></button>`;
}
function boardsView() {
  const l = liveBoards();
  return `${canPlan() ? `<button class="btn" data-newboard>＋ Créer une permanence</button>` : ""}
    <p class="muted" style="margin:0;font-size:13.5px">Stand de papiers cadeaux, buvette, vente de gâteaux… Choisis un créneau pour donner un coup de main.</p>
    ${l.map(boardCard).join("") || `<div class="empty">Aucune permanence pour le moment.</div>`}`;
}
function boardView(id) {
  const b = (D.boards || []).find(x => x.id === id); if (!b) return `<div class="empty">Cette permanence n'existe plus.</div>`;
  const days = boardDays(b), today = todayIso(), day = days.includes(S.bday) ? S.bday : (days.find(d => d >= today) || days[0]);
  const ppl = canPlan() ? [me, ...Object.values(D.P).filter(p => p.id !== me.id && p.role !== "pending").sort((x, y) => x.full_name.localeCompare(y.full_name))] : myPeople();
  const who = ppl.find(p => p.id === S.bwho) || me, mine = myShifts(b), past = day < today;
  return `<div class="card stack"><h2>${esc(b.title)}</h2>
      <span class="muted" style="font-size:13.5px">${boardDates(b)} · de ${hhmm(b.day_start)} à ${hhmm(b.day_end)} · créneaux de ${b.slot_minutes >= 60 ? (b.slot_minutes / 60).toString().replace(".", ",") + " h" : b.slot_minutes + " min"} · ${b.capacity} personne${b.capacity > 1 ? "s" : ""} par créneau${b.place ? "<br>📍 " + esc(b.place) : ""}</span>
      ${b.description ? `<span style="font-size:14px;white-space:pre-wrap">${esc(b.description)}</span>` : ""}
      ${mine.length ? `<div class="eyebrow" style="margin-top:4px">Mes créneaux</div>${mine.map(s => `<div class="row" style="gap:8px;font-size:14px"><span class="tag ok">✓</span><span style="flex:1;text-transform:capitalize">${fmtShort(s.day)} · ${hhmm(s.start_time)}${myPeople().length > 1 ? " · " + esc(first(P(s.person_id).full_name)) : ""}</span></div>`).join("")}` : ""}
      ${canPlan() ? `<div class="row" style="gap:6px;flex-wrap:wrap"><button class="btn small ghost" data-editboard="${b.id}">Modifier</button>${S.confirmBoard === b.id ? `<button class="btn small" data-delboard="${b.id}" style="background:#c43c3c;color:#fff">Confirmer la suppression</button><button class="btn small ghost" data-askdelboard="">Annuler</button>` : `<button class="btn small ghost" data-askdelboard="${b.id}">Supprimer</button>`}</div>` : ""}</div>
    ${ppl.length > 1 ? `<label class="field">Inscrire<select id="bWho">${ppl.map(p => `<option value="${p.id}" ${p.id === who.id ? "selected" : ""}>${p.id === me.id ? "Moi (" + esc(first(me.full_name)) + ")" : esc(p.full_name)}</option>`).join("")}</select></label>` : ""}
    <div class="chips" style="flex-wrap:${days.length > 10 ? "nowrap" : "wrap"}">${days.map(d => { const n = (D.shifts || []).filter(s => s.board_id === b.id && s.day === d && myPeople().some(p => p.id === s.person_id)).length;
      return `<button class="chip" data-bday="${d}" aria-pressed="${d === day}" style="text-transform:capitalize${d < today ? ";opacity:.5" : ""}">${fmtShort(d).replace(/\.$/, "")}${n ? " ✓" : ""}</button>`; }).join("")}</div>
    <div class="daylabel">${fmtDay(day)}</div>
    <div class="list">${boardSlots(b).map(([a, z]) => { const l = shiftsAt(b.id, day, a), full = l.length >= b.capacity, here = l.find(s => s.person_id === who.id);
      return `<div class="item" style="align-items:flex-start;flex-wrap:wrap">
        <span style="width:118px;flex:none;font-weight:700;font-size:14px;white-space:nowrap;font-variant-numeric:tabular-nums">${hhmm(a)} – ${hhmm(z)}</span>
        <span class="txt" style="min-width:120px"><span class="row" style="gap:4px;flex-wrap:wrap">${l.map(s => `<span class="chip" style="padding:3px 9px;font-size:12.5px">${esc(P(s.person_id).full_name)}${canPlan() || myPeople().some(p => p.id === s.person_id) ? ` <button class="x" data-unshift="${b.id}|${day}|${a}|${s.person_id}" aria-label="Retirer" style="border:0;background:none;padding:0 0 0 4px;color:var(--muted)">×</button>` : ""}</span>`).join("")}</span>
          <span class="t2">${full ? "Complet" : `${b.capacity - l.length} place${b.capacity - l.length > 1 ? "s" : ""} libre${b.capacity - l.length > 1 ? "s" : ""}`}</span></span>
        ${past ? "" : here ? `<span class="tag ok">Inscrit·e</span>` : full ? `<span class="tag">Complet</span>` : `<button class="btn small" data-shift="${b.id}|${day}|${a}|${who.id}">${who.id === me.id ? "Je viens" : "Inscrire " + esc(first(who.full_name))}</button>`}</div>`; }).join("")}</div>`;
}
function boardFormView(id) {
  const b = (D.boards || []).find(x => x.id === id) || { title: "Papiers cadeaux", place: "", description: "", start_date: todayIso(), end_date: addDays(todayIso(), 7), day_start: "08:30", day_end: "20:30", slot_minutes: 120, capacity: 3, teams: [] };
  return `<form id="boardForm" class="stack" data-id="${id || ""}">
    <label class="field">Titre<input id="bfTitle" value="${esc(b.title)}" required placeholder="Papiers cadeaux, buvette…"></label>
    <label class="field">Lieu<input id="bfPlace" value="${esc(b.place)}" placeholder="Magasin, adresse…"></label>
    <div class="grid2"><label class="field">Du<input id="bfFrom" type="date" value="${b.start_date}" required></label><label class="field">Au<input id="bfTo" type="date" value="${b.end_date}" required></label></div>
    <div class="grid2"><label class="field">Début de journée<input id="bfStart" type="time" value="${hm(b.day_start)}" required></label><label class="field">Fin de journée<input id="bfEnd" type="time" value="${hm(b.day_end)}" required></label></div>
    <div class="grid2"><label class="field">Durée d'un créneau<select id="bfSlot">${[[30, "30 min"], [60, "1 h"], [90, "1 h 30"], [120, "2 h"], [180, "3 h"], [240, "4 h"], [360, "6 h"]].map(([v, l]) => `<option value="${v}" ${b.slot_minutes === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field">Personnes par créneau<input id="bfCap" type="number" min="1" max="50" value="${b.capacity}" required></label></div>
    <div class="field">Pour qui ?<div class="chips" style="flex-wrap:wrap">${D.teams.map(t => `<label class="chip"><input type="checkbox" name="bftm" value="${t.id}" ${(b.teams || []).includes(t.id) ? "checked" : ""}> ${esc(t.name)}</label>`).join("")}</div>
      <span class="muted" style="font-size:12.5px;font-weight:400">Ne coche rien pour proposer la permanence à tout le club.</span></div>
    <label class="field">Infos pour les bénévoles<textarea id="bfDesc" rows="3" placeholder="Apporter des ciseaux, du scotch…">${esc(b.description)}</textarea></label>
    ${id ? `<p class="muted" style="margin:0;font-size:12.5px">Si tu changes les horaires ou la durée des créneaux, les inscriptions qui ne tombent plus sur un créneau sont retirées.</p>` : ""}
    <button class="btn">${id ? "Enregistrer" : "Créer la permanence"}</button></form>`;
}
function planningView() {
  const teams = planTeams(), own = ownTeams().filter(t => teams.includes(t)), hasMine = own.length > 0 && own.length < teams.length;
  const f = S.filter === "mine" ? (hasMine ? "mine" : "all") : S.filter !== "all" && teams.includes(S.filter) ? S.filter : "all";
  const shownTeams = f === "all" ? teams : f === "mine" ? own : [f];
  const today = todayIso();
  const cat = EV_TYPES[S.cat] ? S.cat : "all";
  let evs = D.events.filter(e => e.date >= today && e.teams.some(t => shownTeams.includes(t)) && (cat === "all" || e.type === cat));
  evs = evs.concat(evs.filter(e => e.type === "comp" && (cat === "all" || cat === "comp")).map(e => ({ e, tr: tripOfEvent(e.id) })).filter(x => x.tr && x.tr.depart_date && x.tr.depart_date < x.e.date && x.tr.depart_date >= today)
    .map(({ e, tr }) => ({ ...e, id: "dep-" + e.id, type: "depart", date: tr.depart_date, start_time: tr.depart_time || "00:00", end_time: "", title: "Départ pour : " + e.title, place: tr.depart_place, _trip: tr })))
    .sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
  const shown = evs.slice(0, S.limit);
  const byDay = {}; shown.forEach(e => (byDay[e.date] = byDay[e.date] || []).push(e));
  const nextComp = evs.find(e => e.type === "comp" && tripOfEvent(e.id));
  let intro = "";
  if (me.role === "parent") {
    const kids = childrenOf(me.id);
    intro = kids.length ? `<div class="notice">${I.user}<span>Tu vois le planning de <b>${kids.map(c => esc(first(c.full_name))).join(", ")}</b>.</span></div>`
      : `<div class="notice">${I.user}<span>Aucun enfant n'est encore relié à ton compte. Demande au bureau de le faire.</span></div>`;
  }
  const nb = liveBoards().length;
  intro += nb || canPlan() ? `<button class="btn ghost" data-boards style="align-self:flex-start">🙋 Permanences${nb ? ` <span class="tag warn">${nb}</span>` : ""}</button>` : "";
  return `${intro}
    ${canPlan() || manageTeams().length ? `<div class="row" style="gap:8px;flex-wrap:wrap">${canPlan() ? `<button class="btn" data-addev>＋ Ajouter un événement</button>` : ""}${manageTeams().length ? `<button class="btn ghost" data-manageteams>👥 Gérer les équipes${reqsToDecide().length ? ` (${reqsToDecide().length})` : ""}</button>` : ""}</div>` : ""}
    ${teams.length > 1 ? `<div class="chips">${hasMine ? `<button class="chip" data-filter="mine" aria-pressed="${f === "mine"}">${own.length > 1 ? "Mes équipes" : "Mon équipe"}</button>` : ""}<button class="chip" data-filter="all" aria-pressed="${f === "all"}">Toutes</button>${teams.map(t => `<button class="chip" data-filter="${esc(t)}" aria-pressed="${f === t}"><span class="dot" style="background:${T(t).color}"></span>${esc(T(t).name)}</button>`).join("")}</div>` : ""}
    <div class="chips">${[["all", "Tout"], ...Object.entries(EV_PLURAL)].map(([k, l]) => `<button class="chip cat-${k}" data-cat="${k}" aria-pressed="${cat === k}">${l}</button>`).join("")}</div>
    ${nextComp ? `<button class="card" data-trip="${tripOfEvent(nextComp.id).id}" style="text-align:left;display:flex;flex-direction:column;gap:4px;border-color:var(--gold)">
      <span class="eyebrow" style="color:var(--accent)">Prochaine compétition</span>
      <span style="font-weight:800;font-family:var(--display);font-size:18px">${esc(nextComp.title)}</span>
      <span class="muted">${fmtDay(nextComp.date)} · ${esc(nextComp.place)}</span>
      <span style="font-weight:700;color:var(--accent)">Voir le départ et le déroulé ›</span></button>` : ""}
    ${Object.keys(byDay).map(d => `<div class="daygroup"><div class="daylabel">${d === today ? "Aujourd'hui · " : ""}${fmtDay(d)}</div>
      ${byDay[d].map(eventCard).join("")}</div>`).join("") || `<div class="empty">Rien de prévu pour le moment.</div>`}
    ${evs.length > shown.length ? `<button class="btn ghost" data-more>Voir la suite du planning</button>` : ""}`;
}
function delChoice(e) {
  const n = seriesOf(e).length;
  return n > 1 ? `<span class="muted" style="font-size:13px;width:100%">Supprimer :</span><button class="btn small danger" data-delev="${e.id}">Cet entraînement</button><button class="btn small danger" data-delseries="${e.id}">Celui-ci et les suivants (${n})</button><button class="btn small ghost" data-cancel>Annuler</button>`
    : `<button class="btn small danger" data-delev="${e.id}">Confirmer la suppression</button><button class="btn small ghost" data-cancel>Annuler</button>`;
}
function eventCard(e) {
  const teams = planTeams(), tr = e._trip || tripOfEvent(e.id), dep = e.type === "depart";
  const kids = me.role === "parent" ? e.teams.flatMap(childrenIn).map(c => first(c.full_name)) : [];
  return `<div class="card ev ${e.type}">
    <div class="time">${hm(e.start_time)}<small>${hm(e.end_time)}</small>${e.no_time ? `<small style="font-weight:600;color:var(--warn)">à confirmer</small>` : ""}</div>
    <div class="body"><div class="row" style="gap:6px;flex-wrap:wrap"><span class="tag ${dep ? "comp" : e.type}">${dep ? "Départ" : evLabel(e.type)}</span>${e.teams.filter(t => teams.includes(t)).map(teamChip).join("")}</div>
      <div class="title">${esc(e.title)}</div><div class="muted" style="font-size:13px">${esc(e.place)}</div>
      ${kids.length ? `<div style="font-size:13px">Concerne : ${kids.map(esc).join(", ")}</div>` : ""}
      ${dep ? "" : attendanceBlock(e)}
      <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:2px">
        ${tr ? `<button class="btn small" data-trip="${tr.id}">Voir le déplacement</button>` : ""}
        ${canPlan() && !dep ? `<button class="btn small ghost" data-editev="${e.id}">Modifier</button>` : ""}
        ${canPlan() && !dep ? (S.confirm === e.id ? delChoice(e) : `<button class="btn small ghost" data-askdel="${e.id}">Supprimer</button>`) : ""}
      </div>
    </div></div>`;
}

/* Photo de profil (ou initiales) */
function avatar(p, size = 36) {
  const st = `width:${size}px;height:${size}px;font-size:${Math.round(size * .36)}px`;
  return p && p.photo_path ? `<img class="av" data-path="${esc(p.photo_path)}" data-ini="${initials(p.full_name)}" alt="" style="${st};object-fit:cover">` : `<span class="av" style="${st}">${initials(p && p.full_name)}</span>`;
}
const photoBtn = (id, label = "📷 Photo") => `<label class="btn small ghost">${label}<input type="file" hidden accept="image/*" data-photo="${id}"></label>`;
// Carré 480 px, pour une photo de profil légère
async function squarePhoto(file) {
  const bmp = await createImageBitmap(file), side = Math.min(bmp.width, bmp.height), out = 480;
  const c = document.createElement("canvas"); c.width = c.height = out;
  c.getContext("2d").drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
  const blob = await new Promise(res => c.toBlob(res, "image/jpeg", 0.85));
  return new File([blob], "photo.jpg", { type: "image/jpeg" });
}
const consentTag = id => PV(id).image_consent === false ? '<span class="tag comp" style="font-size:10.5px;padding:2px 7px;white-space:nowrap" title="Refuse la publication de son image">📵 Pas de publication</span>' : "";
function consentPick(name, val, who) {
  return `<div class="field">Publication ${who} (réseaux sociaux, site du club, presse, affiches)<div class="chips" style="flex-wrap:wrap">
    <label class="chip"><input type="radio" name="${name}" value="true" ${val === true ? "checked" : ""}> J'accepte</label>
    <label class="chip"><input type="radio" name="${name}" value="false" ${val === false ? "checked" : ""}> Je refuse</label></div></div>`;
}
const consentVal = (root, name) => { const r = root.querySelector(`[name="${name}"]:checked`); return r ? r.value === "true" : null; };

/* Coordonnées (fiche privée) */
const PV = id => (D && D.priv[id]) || {};
const GENDERS = [["F", "Femme"], ["H", "Homme"], ["N", "Sans genre"]];
const genderLabel = (g, kid) => g === "F" ? (kid ? "Fille" : "Femme") : g === "H" ? (kid ? "Garçon" : "Homme") : g === "N" ? "Sans genre" : "";
const genderSign = g => g === "F" ? "♀" : g === "H" ? "♂" : "";
// Deux cases Prénom / Nom (le nom complet reste enregistré en un seul champ)
const splitName = n => { const w = (n || "").trim().split(/\s+/); return [w[0] || "", w.slice(1).join(" ")]; };
const nameFields = (pre, full) => { const [f, l] = splitName(full); return `<div class="grid2"><label class="field">Prénom<input id="${pre}First" value="${esc(f)}" required></label><label class="field">Nom<input id="${pre}Last" value="${esc(l)}" required></label></div>`; };
const joinName = pre => [document.getElementById(pre + "First").value, document.getElementById(pre + "Last").value].map(x => x.trim()).filter(Boolean).join(" ");
const tel = p => p ? `<a href="tel:${esc(p.replace(/[^\d+]/g, ""))}">${esc(p)}</a>` : '<span class="muted">non renseigné</span>';
const isLegal = (pid, aid) => !!(D.links.find(l => l.parent_id === pid && l.athlete_id === aid) || {}).legal;
// Pictogrammes colorés femme / homme
const GICON = {
  F: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><circle cx="12" cy="5" r="3.2" fill="#e0559a"/><path d="M12 9.2c-2.2 0-3.4 1.2-3.9 3.1L6.6 18h3l-.1 4h5l-.1-4h3l-1.5-5.7c-.5-1.9-1.7-3.1-3.9-3.1z" fill="#e0559a"/></svg>',
  H: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><circle cx="12" cy="5" r="3.2" fill="#2f7fd8"/><path d="M8.6 9.4h6.8c1.3 0 2.1.9 2.1 2.1V16h-2v6h-3v-5h-1v5h-3v-6h-2v-4.5c0-1.2.8-2.1 2.1-2.1z" fill="#2f7fd8"/></svg>',
  N: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><circle cx="12" cy="5" r="3.2" fill="#8b5cf6"/><path d="M12 9.2c-2.6 0-4 1.3-4 3.4V16h2v6h4v-6h2v-3.4c0-2.1-1.4-3.4-4-3.4z" fill="#8b5cf6"/></svg>',
};
function genderPick(name, val, kid) { return `<div class="chips gpick">${GENDERS.map(([v]) => `<label class="chip g-${v}" title="${genderLabel(v, kid)}"><input type="radio" name="${name}" value="${v}" ${val === v ? "checked" : ""} aria-label="${genderLabel(v, kid)}">${GICON[v]}</label>`).join("")}</div>`; }
// Bloc « contacts » d'un athlète : ses parents, le responsable légal, la personne à prévenir
function contactsOf(a) {
  const pv = PV(a.id), par = parentsOf(a.id);
  return `<div class="stack" style="gap:4px;font-size:13.5px">
    ${a.managed ? "" : `<div>📞 ${esc(first(a.full_name))} : ${tel(PV(a.id).phone)}</div>`}
    ${par.map(x => `<div>👤 ${esc(x.full_name)}${isLegal(x.id, a.id) ? ' <span class="tag ok">Responsable légal</span>' : ""} : ${tel(PV(x.id).phone)}</div>`).join("") || '<div class="muted">Aucun parent relié</div>'}
    <div>🚨 En cas de problème : ${pv.emergency_name ? esc(pv.emergency_name) + " · " + tel(pv.emergency_phone) : '<span class="muted">non renseigné</span>'}</div></div>`;
}
async function savePriv(id, patch) {
  const [row] = await q(sb.from("profile_private").upsert({ id, ...patch }).select());
  D.priv[id] = row || { ...PV(id), ...patch };
}

/* Catégories d'événements */
const EV_TYPES = { train: "Entraînement", comp: "Compétition", camp: "Camp / stage", event: "Événement club" };
const EV_PLURAL = { train: "Entraînements", comp: "Compétitions", camp: "Camps / stages", event: "Événements" };
const evLabel = t => EV_TYPES[t] || "Événement";
// Vacances scolaires (zone A) : pas d'entraînement, sautées quand on répète un entraînement chaque semaine
const HOLIDAYS = [["2026-10-17", "2026-11-01"], ["2026-12-19", "2027-01-03"], ["2027-02-13", "2027-02-28"], ["2027-04-10", "2027-04-25"], ["2027-07-03", "2027-08-31"]];
const inHolidays = d => HOLIDAYS.some(([a, b]) => d >= a && d <= b);

/* Série d'entraînements : même titre, mêmes équipes, même jour de la semaine et même heure, à partir de cette date */
function seriesOf(e) {
  if (!e || e.type !== "train") return e ? [e] : [];
  const key = x => [x.title, x.teams.join(","), new Date(x.date + "T12:00:00").getDay(), hm(x.start_time)].join("|"), k = key(e);
  return D.events.filter(x => x.type === "train" && x.date >= e.date && key(x) === k);
}
const chunks = (a, n = 100) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const dayDiff = (a, b) => Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 864e5);

/* ============ Présences aux entraînements ============ */
function attOf(eid, aid) { return (D.attendance || []).find(a => a.event_id === eid && a.athlete_id === aid); }
const isAbsent = (eid, aid) => (attOf(eid, aid) || {}).status === "absent";
// Coachs des équipes de l'événement : présents par défaut
function coachesOf(e) { return Object.values(D.P).filter(p => p.role === "coach" && coachTeamsOf(p.id).some(t => e.teams.includes(t))).sort((a, b) => a.full_name.localeCompare(b.full_name)); }
function rollAthletes(e) {
  const teams = isBureau() ? e.teams : me.role === "coach" ? e.teams.filter(t => coachTeamsOf(me.id).includes(t)) : [];
  return athletes().filter(a => teams.includes(a.team_id));
}
function attendanceBlock(e) {
  let html = "";
  const mine = myAthletes().filter(a => e.teams.includes(a.team_id));
  if (me.role === "coach" && !mine.some(a => a.id === me.id) && e.teams.some(t => coachTeamsOf(me.id).includes(t))) mine.unshift(me);
  for (const a of mine) {
    const at = attOf(e.id, a.id), st = at ? at.status : "present", key = e.id + "|" + a.id;
    html += `<div class="stack" style="gap:6px;border-top:1px solid var(--line);padding-top:8px;margin-top:4px">
      <div class="row" style="gap:6px;flex-wrap:wrap"><span style="font-size:13px;font-weight:700;flex:1;min-width:0">${a.id === me.id ? (me.role === "coach" && !e.teams.includes(me.team_id) ? "Ma présence (coach)" : "Ma présence") : esc(first(a.full_name))}</span>
        <button class="btn small ${st === "present" ? "" : "ghost"}" data-att="${key}|present">✓ Présent·e</button>
        <button class="btn small ${st === "absent" ? "danger" : "ghost"}" data-att="${key}|absent">✗ Absent·e</button></div>
      ${st === "absent" ? `<div class="row" style="gap:6px;flex-wrap:wrap">
          <input class="search" style="flex:1;min-width:150px;padding:7px 10px" id="why-${e.id}-${a.id}" data-why="${key}" value="${esc(at.reason || "")}" placeholder="Motif (malade, blessure…)" aria-label="Motif de l'absence">
          ${at.file_path ? `<button class="link" style="font-size:13px" data-open="${esc(at.file_path)}">📎 ${esc(at.file_name || "Justificatif")}</button>` : ""}
          <label class="btn small ghost">📷<input type="file" hidden accept="image/*" capture="environment" data-attfile="${key}" aria-label="Photo du justificatif"></label>
          <label class="btn small ghost">📁 Justificatif<input type="file" hidden accept="image/*,.pdf" data-attfile="${key}"></label></div>` : ""}
    </div>`;
  }
  const roll = rollAthletes(e), co = coachesOf(e), cab = co.filter(c => isAbsent(e.id, c.id));
  if (roll.length) {
    const ab = roll.filter(a => isAbsent(e.id, a.id)).length, p = roll.length - ab;
    html += `<button class="row" data-roll="${e.id}" style="gap:8px;border:0;background:var(--surface-2);border-radius:10px;padding:8px 10px;font-size:13px;margin-top:4px;text-align:left;width:100%;flex-wrap:wrap">
      <span class="tag ok">${p} présent${p > 1 ? "s" : ""} sur ${roll.length}</span>${ab ? `<span class="tag comp">${ab} absent${ab > 1 ? "s" : ""}</span>` : ""}${co.length ? `<span class="tag ${cab.length ? "warn" : "ok"}">${co.length - cab.length}/${co.length} coach${co.length > 1 ? "s" : ""}</span>` : ""}<span style="margin-left:auto;font-weight:700">Voir l'appel ›</span></button>`;
  } else {
    const sm = D.sum[e.id];
    if (sm && sm.total) { const p = sm.total - sm.absent;
      html += `<div class="row" style="gap:8px;font-size:13px;margin-top:4px;flex-wrap:wrap"><span class="tag ok">${p} présent${p > 1 ? "s" : ""} sur ${sm.total}</span>${sm.absent ? `<span class="muted">${sm.absent} absent${sm.absent > 1 ? "s" : ""}</span>` : ""}</div>`; }
    if (cab.length) html += `<div class="row" style="gap:6px;font-size:13px;margin-top:4px;flex-wrap:wrap">${cab.map(c => `<span class="tag warn">Coach ${esc(first(c.full_name))} absent·e</span>`).join("")}</div>`;
  }
  return html;
}
function rollView(id) {
  const e = D.events.find(x => x.id === id); if (!e) return `<div class="empty">Cet événement n'existe plus.</div>`;
  const roll = rollAthletes(e), ab = roll.filter(a => isAbsent(e.id, a.id)).length;
  return `<div class="card"><b>${esc(e.title)}</b><br><span class="muted" style="text-transform:capitalize">${fmtDay(e.date)} · ${hm(e.start_time)}</span>
    <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap"><span class="tag ok">${roll.length - ab} présent${roll.length - ab > 1 ? "s" : ""} sur ${roll.length}</span>${ab ? `<span class="tag comp">${ab} absent${ab > 1 ? "s" : ""}</span>` : ""}</div>
    <p class="muted" style="margin:6px 0 0;font-size:12.5px">Tout le monde est compté présent, sauf si l'athlète, un parent ou le coach a déclaré une absence.</p></div>
    ${coachesOf(e).length ? `<div class="daylabel">Coachs</div><div class="list">${coachesOf(e).map(c => { const at = attOf(e.id, c.id), st = at ? at.status : "present";
      return `<div class="item" style="align-items:flex-start">${avatar(c, 36)}<span class="txt"><span class="t1">${esc(c.full_name)}</span><span class="t2">${coachTeamsOf(c.id).filter(t => e.teams.includes(t)).map(t => esc(T(t).name)).join(", ")}${st === "absent" ? " · " + esc(at.reason || "Pas de motif") : ""}</span></span>
        ${st === "absent" ? '<span class="tag comp">Absent·e</span>' : '<span class="tag ok">Présent·e</span>'}</div>`; }).join("")}</div>` : ""}
    ${[...new Set(roll.map(a => a.team_id))].map(t => `<div class="daylabel">Équipe ${esc(T(t).name)}</div><div class="list">${roll.filter(a => a.team_id === t).sort((a, b) => isAbsent(e.id, b.id) - isAbsent(e.id, a.id)).map(a => { const at = attOf(e.id, a.id), st = at ? at.status : "present";
      return `<div class="item" style="align-items:flex-start">${avatar(a, 36)}<span class="txt"><span class="t1">${esc(a.full_name)} ${consentTag(a.id)}</span>
        ${st === "absent" ? `<span class="t2" style="white-space:normal">${esc(at.reason || "Pas de motif")}</span>${at.file_path ? `<button class="link" style="font-size:13px;padding:0;display:block" data-open="${esc(at.file_path)}">📎 Voir le justificatif</button>` : ""}` : ""}
        <details style="margin-top:4px"><summary class="muted" style="font-size:13px;cursor:pointer">Contacts</summary>${contactsOf(a)}</details></span>
        ${st === "absent" ? '<span class="tag comp">Absent·e</span>' : '<span class="tag ok">Présent·e</span>'}</div>`; }).join("")}</div>`).join("") || `<div class="empty">Aucun athlète dans ces équipes.</div>`}`;
}
async function saveAtt(eid, aid, patch) {
  const cur = attOf(eid, aid) || { event_id: eid, athlete_id: aid, status: "absent", reason: "" };
  const row = { event_id: eid, athlete_id: aid, status: cur.status, reason: cur.reason || "", file_path: cur.file_path || null, file_name: cur.file_name || null, ...patch, updated_by: me.id, updated_at: new Date().toISOString() };
  const [res] = await q(sb.from("attendance").upsert(row).select());
  D.attendance = (D.attendance || []).filter(a => !(a.event_id === eid && a.athlete_id === aid)).concat([res]);
  await loadSummary([eid]);
}

/* ============ Tchats ============ */
function lastOf(key) { const l = msgsOf(key); return l[l.length - 1]; }
function preview(m) { return m ? (m.is_announcement ? "📣 " : "") + first(P(m.sender_id).full_name) + " : " + (m.body || (m.file_name ? "📎 " + m.file_name : "")) : ""; }
function chatsView() {
  const teams = myTeams().filter(t => T(t).active !== false);
  const teamRow = t => {
    const key = "team:" + t, m = lastOf(key), n = unreadIn(key), tm = T(t);
    const sub = me.role === "parent" ? "Pour " + childrenIn(t).map(c => first(c.full_name)).join(", ") : "Athlètes, parents et bureau";
    return `<button class="item" data-conv="${key}"><span class="gico" style="background:${tm.color}">${esc(tm.name[0])}</span>
      <span class="txt"><span class="t1">Équipe ${esc(tm.name)}${n ? `<span class="tag comp">${n}</span>` : ""}</span><span class="t2">${esc(m ? preview(m) : sub)}</span></span>
      <span class="when">${m ? fmtTs(m.created_at) : ""}</span></button>`;
  };
  const teamRows = teams.filter(t => !isArchived("team:" + t)).map(teamRow).join("") || `<div class="item muted">Aucune équipe pour l'instant.</div>`;
  // Conversations déjà commencées, plus le bureau et les coachs (pour les athlètes et parents)
  const withMsgs = new Set(D.msgs.filter(m => !m.team_id).map(convOf).filter(k => msgsOf(k).length).map(k => k.slice(3)));
  const always = isBureau() || me.role === "coach" ? [] : dmPartners().map(p => p.id);
  let partners = Object.values(D.P).filter(p => p.id !== me.id && (withMsgs.has(p.id) || always.includes(p.id)));
  partners.sort((a, b) => ((lastOf("dm:" + b.id) || {}).created_at || "").localeCompare((lastOf("dm:" + a.id) || {}).created_at || ""));
  const dmRows = partners.filter(p => !isArchived("dm:" + p.id)).map(dmRow).join("") || `<div class="item muted">Aucune conversation privée pour l'instant.</div>`;
  const arch = [...teams.filter(t => isArchived("team:" + t)).map(teamRow), ...partners.filter(p => isArchived("dm:" + p.id)).map(dmRow)];
  return `
    <div class="eyebrow">${me.role === "athlete" ? "Mon équipe" : me.role === "parent" ? "Équipes de mes enfants" : "Toutes les équipes"}</div>
    <div class="list">${teamRows}</div>
    <div class="row" style="justify-content:space-between"><div class="eyebrow">Messages privés</div><button class="btn small" data-contacts>💬 Écrire à quelqu'un</button></div>
    <div class="list">${dmRows}</div>
    ${arch.length ? `<details class="stack" ${S.showArch ? "open" : ""} data-archbox><summary class="eyebrow" style="cursor:pointer">🗄️ Conversations archivées (${arch.length})</summary><div class="list" style="margin-top:8px">${arch.join("")}</div></details>` : ""}
    <div class="notice">${I.lock}<span>${isBureau() ? "Les messages privés ne sont visibles que par toi et la personne concernée." : "Les messages privés ne sont visibles que par toi et la personne à qui tu écris."}</span></div>`;
}
function contactsView() {
  const qs = (S.cq || "").toLowerCase(), list = dmPartners().filter(p => p.full_name.toLowerCase().includes(qs));
  const groups = [["Bureau", list.filter(p => p.role === "bureau")], ["Coachs", list.filter(p => p.role === "coach")],
    ...D.teams.filter(t => isBureau() || myTeams().includes(t.id)).map(t => ["Équipe " + t.name, [...list.filter(p => isAth(p) && p.team_id === t.id), ...list.filter(p => p.role === "parent" && childrenOf(p.id).some(c => c.team_id === t.id))]])];
  return `<input class="search" id="cq" placeholder="Rechercher un nom…" aria-label="Rechercher">
    ${groups.map(([g, l]) => l.length ? `<div class="daylabel">${esc(g)}</div><div class="list">${l.map(p => `<button class="item" data-conv="dm:${p.id}">${avatar(p, 40)}<span class="txt"><span class="t1">${esc(p.full_name)}</span><span class="t2">${esc(roleLabel(p))}</span></span><span class="btn small">💬</span></button>`).join("")}</div>` : "").join("") || `<div class="empty">Personne à qui écrire pour l'instant.</div>`}`;
}
function dmRow(p) {
  const key = "dm:" + p.id, m = lastOf(key), n = unreadIn(key);
  return `<button class="item" data-conv="${key}">${avatar(p, 40)}
    <span class="txt"><span class="t1">${esc(p.full_name)}${n ? `<span class="tag comp">${n}</span>` : ""}</span><span class="t2">${esc(m ? (m.body || "📎 " + m.file_name) : roleLabel(p))}</span></span>
    <span class="when">${m ? fmtTs(m.created_at) : ""}</span></button>`;
}
function fileHtml(f) {
  const img = (f.file_type || "").startsWith("image/");
  return `${img ? `<img class="thumb" data-path="${esc(f.file_path)}" alt="">` : ""}<button class="file" data-open="${esc(f.file_path)}" style="border:0;background:none;padding:0;color:inherit;text-align:left"><span class="fi">${I.doc}</span><span style="min-width:0"><span class="fn">${esc(f.file_name)}</span><small>${fmtSize(f.file_size)} · ouvrir</small></span></button>`;
}
// Menu d'un message (toucher la bulle) : supprimer pour moi / pour tout le monde
function msgMenu(key, m) {
  const all = m.sender_id === me.id || isBureau();
  return `<div class="row" style="gap:6px;flex-wrap:wrap;margin-top:2px;justify-content:${m.sender_id === me.id ? "flex-end" : "flex-start"}">
    <button type="button" class="btn small ghost" data-delmsg="${m.id}|me">Supprimer pour moi</button>
    ${all ? `<button type="button" class="btn small" data-delmsg="${m.id}|all" style="background:#c43c3c;color:#fff">Supprimer pour tout le monde</button>` : ""}
    <button type="button" class="btn small ghost" data-msgmenu="">Annuler</button></div>`;
}
function convView(key) {
  const [type, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  let title, note;
  if (type === "team") { const t = T(id); title = "Équipe " + t.name; note = `<div class="notice">${I.user}<span>Groupe de l'équipe ${esc(t.name)} : athlètes, parents et bureau.</span></div>`; }
  else { const p = P(id); title = p.full_name; note = `<div class="notice">${I.lock}<span>Conversation privée avec <b>${esc(p.full_name)}</b> (${esc(roleLabel(p))}).</span></div>`; }
  markRead(key);
  if (!S.loadedConv || S.loadedConv !== key) { S.loadedConv = key; loadConv(key); }
  const list = msgsOf(key);
  const ask = S.convAsk && S.convAsk.key === key ? S.convAsk.what : null;
  const tools = `<div class="row" style="gap:6px;flex-wrap:wrap">
      <button type="button" class="btn small ghost" data-convarch="${key}">${isArchived(key) || prefOf(key).archived_at && !list.length ? "📤 Désarchiver" : "🗄️ Archiver"}</button>
      <button type="button" class="btn small ghost" data-convask="${key}|clear">🧹 Supprimer pour moi</button>
      ${canWipe(key) ? `<button type="button" class="btn small ghost" data-convask="${key}|wipe">🗑️ Supprimer pour tout le monde</button>` : ""}</div>
    <span class="muted" style="font-size:12.5px">Touche un message pour le supprimer.</span>
    ${ask ? `<div class="stack" style="gap:8px;border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:var(--surface-2)">
      <span style="font-size:13.5px">${ask === "clear" ? "<b>Vider cette conversation pour toi ?</b> Les messages actuels disparaissent seulement de ton téléphone et de ton compte. Les autres les voient toujours."
        : `<b>Supprimer tous les messages pour tout le monde ?</b> ${key.startsWith("team:") ? "Toute l'équipe" : "L'autre personne"} ne les verra plus non plus, et les fichiers joints sont effacés. C'est définitif.`}</span>
      <div class="row" style="gap:8px"><button type="button" class="btn small" data-convdo="${key}|${ask}" style="${ask === "wipe" ? "background:#c43c3c;color:#fff" : ""}">${ask === "clear" ? "Vider pour moi" : "Supprimer pour tout le monde"}</button><button type="button" class="btn small ghost" data-convask="">Annuler</button></div></div>` : ""}`;
  const body = `${note}${tools}<div class="chat">${list.map(m => {
    const a = P(m.sender_id), mine = m.sender_id === me.id;
    return `<div class="msg ${mine && !m.is_announcement ? "me" : ""} ${m.is_announcement ? "annonce" : ""}"><span class="meta">${m.is_announcement ? "📣 Annonce du bureau · " + esc(a.full_name) : mine ? "Moi" : esc(a.full_name) + " · " + esc(roleLabel(a))} · ${fmtTs(m.created_at)}</span><div class="bubble" data-msgmenu="${m.id}" style="cursor:pointer">${m.file_path ? fileHtml(m) : ""}${m.body ? esc(m.body) : ""}</div>${S.msgMenu === m.id ? msgMenu(key, m) : ""}${mine ? seenTag(key, m) : ""}${mine && S.readersOpen === m.id ? `<div class="readers">${readersOf(key, m).map(u => esc(P(u).full_name)).sort().join(", ")}</div>` : ""}</div>`;
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
  if (file) file = await shrink(file);
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
  const imgs = [...$app.querySelectorAll("img[data-path]")];
  // Liens demandés en une seule fois pour toutes les photos de la page
  const need = [...new Set(imgs.map(i => i.dataset.path).filter(p => !(urlCache[p] && urlCache[p].exp > Date.now())))];
  if (need.length > 1 && sb.storage.from(BUCKET).createSignedUrls) {
    try { const { data } = await sb.storage.from(BUCKET).createSignedUrls(need, 3600);
      (data || []).forEach(d => { if (d.signedUrl) urlCache[d.path] = { url: d.signedUrl, exp: Date.now() + 3500e3 }; }); } catch (e) {}
  }
  for (const img of imgs) {
    try { img.src = await signedUrl(img.dataset.path); } catch (e) { if (img.classList.contains("av")) { const sp = document.createElement("span"); sp.className = "av"; sp.style.cssText = img.style.cssText; sp.textContent = img.dataset.ini || "?"; img.replaceWith(sp); } else img.remove(); }
  }
}

/* ============ Déplacements ============ */
const tripOfEvent = eid => tripList().find(t => t.event_id === eid);
function tripList() { return Array.isArray(D.trips) ? D.trips : Object.values(D.trips); }
function eventOf(tr) { return D.events.find(e => e.id === tr.event_id); }
const MODES = { Bus: "🚌", Avion: "✈️", Train: "🚆", Voiture: "🚗", Minibus: "🚐", Bateau: "⛴️" };
const KINDS = { aller: "Aller", retour: "Retour", autre: "Trajet" };
function tripDays(tr) {
  const e = eventOf(tr), a = tr.depart_date || e.date, b = tr.return_date && tr.return_date >= a ? tr.return_date : (e.date > a ? e.date : a);
  const out = []; for (let d = a; d <= b && out.length < 31; d = addDays(d, 1)) out.push(d); return out;
}
function legsOf(tid) { return (D.legs || []).filter(l => l.trip_id === tid).sort((a, b) => ((a.day || "") + (a.time || "")).localeCompare((b.day || "") + (b.time || ""))); }
function stepsOf(tid) { return D.steps.filter(s => s.trip_id === tid).sort((a, b) => ((a.day || "") + a.time).localeCompare((b.day || "") + b.time)); }
function itemsOf(tid) { return D.items.filter(i => i.trip_id === tid).sort((a, b) => a.position - b.position); }
function concerned(tr) {
  const e = eventOf(tr); if (!e) return [];
  return myAthletes().filter(a => e.teams.includes(a.team_id));
}
function presenceOf(tid, aid) { const p = D.presence.find(x => x.trip_id === tid && x.athlete_id === aid); return p && p.status; }
function packedOf(tid, aid) { const ids = new Set(itemsOf(tid).map(i => i.id)); return D.packed.filter(p => p.athlete_id === aid && ids.has(p.item_id)).map(p => p.item_id); }
function tripsView() {
  const teams = planTeams(), today = todayIso();
  const list = tripList().map(tr => ({ tr, e: eventOf(tr) })).filter(x => x.e && x.e.date >= today && x.e.teams.some(t => teams.includes(t))).sort((a, b) => a.e.date.localeCompare(b.e.date));
  if (!list.length) return `<div class="empty">Aucun déplacement prévu.${canPlan() ? "<br>Ajoute une compétition depuis le planning." : ""}</div>`;
  return `<p class="muted" style="margin:0">Pour chaque compétition : départ, transport, déroulé de la journée et affaires à emporter.</p>` + list.map(({ tr, e }) => {
    const c = concerned(tr), n = itemsOf(tr.id).length;
    const ok = c.length && c.every(a => presenceOf(tr.id, a.id) === "yes");
    return `<button class="card" data-trip="${tr.id}" style="text-align:left;display:flex;flex-direction:column;gap:6px">
      <div class="row" style="justify-content:space-between"><span class="tag comp">${fmtShort(e.date)}</span>${c.length ? (ok ? `<span class="tag ok">Présence confirmée</span>` : `<span class="tag warn">À confirmer</span>`) : ""}</div>
      <span style="font-weight:800;font-family:var(--display);font-size:17px">${esc(e.title)}</span>
      <span class="row" style="gap:6px;flex-wrap:wrap">${e.teams.filter(t => teams.includes(t)).map(teamChip).join("")}</span>
      <span class="muted" style="font-size:13.5px">Départ ${fmtShort(tr.depart_date || e.date)}${tr.depart_time ? " à " + hm(tr.depart_time) : ""}${tr.return_date && tr.return_date !== (tr.depart_date || e.date) ? " · retour " + fmtShort(tr.return_date) : ""}</span>
      <span class="muted" style="font-size:13.5px">${legsOf(tr.id).map(l => MODES[l.mode] || "").filter(Boolean).join(" ")} ${esc(tr.depart_place)}</span>
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
  const steps = stepsOf(id), days = tripDays(tr), multi = days.length > 1, legs = legsOf(id);
  const edit = canPlan() && S.editTrip === id;
  const dayOpts = sel => days.map(d => `<option value="${d}" ${d === sel ? "selected" : ""}>${fmtShort(d)}</option>`).join("");
  return `
    <div class="hero">
      <span class="lbl">Compétition le ${fmtDay(e.date)}${multi ? " · déplacement de " + days.length + " jours" : ""}</span><h2>${esc(e.title)}</h2>
      <div class="grid"><div><div class="lbl">Départ</div><div style="font-weight:700;text-transform:capitalize">${fmtShort(tr.depart_date || e.date)}</div><div class="big">${tr.depart_time ? hm(tr.depart_time) : "–"}</div></div>
        <div><div class="lbl">Retour</div><div style="font-weight:700;text-transform:capitalize">${fmtShort(tr.return_date || tr.depart_date || e.date)}</div><div style="font-weight:700;font-size:18px;margin-top:6px">${esc(tr.return_time || "–")}</div></div></div>
      <div><div class="lbl">Rendez-vous</div><div style="font-weight:600">${esc(tr.depart_place || "À préciser")}</div></div>
      <div><div class="lbl">Transport</div><div style="font-weight:600">${esc(tr.transport || "À préciser")}</div></div>
      <div><div class="lbl">Lieu de la compétition</div><div style="font-weight:600">${esc(e.place)}</div></div>
      ${tr.lodging ? `<div><div class="lbl">Hébergement</div><div style="font-weight:600">${esc(tr.lodging)}</div></div>` : ""}
    </div>
    ${canPlan() ? (edit ? `<form id="tripForm" class="card stack"><h2>Modifier le déplacement</h2>
        <div class="grid2"><label class="field">Jour de départ<input id="tfDate" type="date" value="${tr.depart_date || e.date}"></label><label class="field">Heure de départ<input id="tfTime" type="time" value="${hm(tr.depart_time)}"></label></div>
        <div class="grid2"><label class="field">Jour de retour<input id="tfRDate" type="date" value="${tr.return_date || tr.depart_date || e.date}"></label><label class="field">Heure de retour<input id="tfRet" value="${esc(tr.return_time)}" placeholder="vers 3h du matin"></label></div>
        <label class="field">Hébergement<input id="tfLodging" value="${esc(tr.lodging || "")}" placeholder="Hôtel, adresse… (si nuit sur place)"></label>
        <label class="field">Lieu de rendez-vous<input id="tfPlace" value="${esc(tr.depart_place)}"></label>
        <label class="field">Transport<input id="tfTransport" value="${esc(tr.transport)}"></label>
        <label class="field">Responsable et téléphone<input id="tfContact" value="${esc(tr.contact)}"></label>
        <div class="row"><button class="btn small">Enregistrer</button><button type="button" class="btn small ghost" data-canceledit>Annuler</button></div></form>`
      : `<div class="row" style="gap:6px;flex-wrap:wrap"><button class="btn small ghost" data-edittrip="${id}">Modifier le départ, l'hébergement…</button>
          <button class="btn small ghost" data-editev="${e.id}">Modifier la compétition</button>
          ${S.confirm === e.id ? `<button class="btn small danger" data-delev="${e.id}">Confirmer la suppression</button><button class="btn small ghost" data-cancel>Annuler</button>` : `<button class="btn small ghost" data-askdel="${e.id}">Supprimer la compétition</button>`}</div>`) : ""}
    ${presence}
    ${legs.length || canPlan() ? `<div class="card stack"><h2>Trajets</h2>
      ${legs.map(l => `<div class="doc"><span class="fi" style="width:40px;height:40px;border-radius:10px;background:var(--accent-soft);display:grid;place-items:center;font-size:20px;flex:none">${MODES[l.mode] || "🚌"}</span>
        <span class="txt"><b>${KINDS[l.kind] || "Trajet"} · ${esc(l.mode)}</b>
        <span style="display:block;font-size:13.5px"><span class="muted">Départ</span> ${l.day ? fmtShort(l.day) : ""}${l.time ? " à " + hm(l.time) : ""}${l.from_place ? " · " + esc(l.from_place) : ""}</span>
        ${l.arrive_day || l.arrive_time || l.to_place ? `<span style="display:block;font-size:13.5px"><span class="muted">Arrivée</span> ${l.arrive_day ? fmtShort(l.arrive_day) : ""}${l.arrive_time ? " à " + hm(l.arrive_time) : ""}${l.to_place ? " · " + esc(l.to_place) : ""}</span>` : ""}
        ${l.details ? `<small style="white-space:normal">${esc(l.details)}</small>` : ""}</span>
        ${canPlan() ? `<button class="x" style="border:0;background:none;color:var(--muted);font-size:18px" data-delleg="${l.id}" aria-label="Retirer ce trajet">×</button>` : ""}</div>`).join("") || '<span class="muted">Ajoute l\'aller et le retour (bus, avion…).</span>'}
      ${canPlan() ? `<details><summary style="font-weight:700;cursor:pointer">Ajouter un trajet</summary><form id="addleg" class="stack" style="margin-top:10px">
        <div class="grid2"><label class="field">Type<select id="lgKind"><option value="aller">Aller</option><option value="retour">Retour</option><option value="autre">Autre trajet</option></select></label>
          <label class="field">Transport<select id="lgMode">${Object.keys(MODES).map(m => `<option>${m}</option>`).join("")}</select></label></div>
        <label class="field">Départ de<input id="lgFrom" placeholder="Pau"></label>
        <div class="grid2"><label class="field">Jour de départ<select id="lgDay">${dayOpts(tr.depart_date || e.date)}</select></label><label class="field">Heure de départ<input id="lgTime" type="time"></label></div>
        <label class="field">Arrivée à<input id="lgTo" placeholder="Aéroport de Toulouse"></label>
        <div class="grid2"><label class="field">Jour d'arrivée<select id="lgADay"><option value="">–</option>${dayOpts("")}</select></label><label class="field">Heure d'arrivée<input id="lgATime" type="time"></label></div>
        <p class="muted" style="margin:0;font-size:12.5px">Un trajet par moyen de transport : par exemple bus Pau → Toulouse, puis avion Toulouse → Orlando, puis bus jusqu'à l'hôtel.</p>
        <label class="field">Détails<input id="lgDetails" placeholder="N° de vol, compagnie, rendez-vous à l'aéroport…"></label>
        <button class="btn small" style="align-self:flex-start">Ajouter le trajet</button></form></details>` : ""}
    </div>` : ""}
    <div class="card stack"><h2>${multi ? "Programme du déplacement" : "Déroulé de la journée"}</h2><div class="timeline">${steps.map((s, i) => `${multi && (i === 0 || steps[i - 1].day !== s.day) ? `<div class="daylabel" style="padding:4px 0 8px">${s.day ? fmtDay(s.day) : "Jour non précisé"}</div>` : ""}<div class="step"><span class="h">${hm(s.time)}</span><span class="bul"></span><span class="row" style="justify-content:space-between;align-items:flex-start"><span>${esc(s.label)}</span>${canPlan() ? `<button class="x" style="border:0;background:none;color:var(--muted);font-size:18px" data-delstep="${s.id}" aria-label="Retirer">×</button>` : ""}</span></div>`).join("") || '<span class="muted">Le déroulé sera bientôt précisé.</span>'}</div>
      ${canPlan() ? `<form id="addstep" class="row" style="gap:6px;flex-wrap:wrap">${multi ? `<select id="stD" class="search" style="width:auto" aria-label="Jour">${dayOpts(S.lastStepDay || days[0])}</select>` : ""}<input id="stH" type="time" aria-label="Heure" class="search" style="width:110px"><input id="stL" aria-label="Étape" placeholder="Nouvelle étape" class="search"><button class="btn small">Ajouter</button></form>` : ""}
    </div>
    ${bringBlock(tr)}
    ${tr.contact ? `<div class="card"><div class="eyebrow">Responsable du déplacement</div><div style="font-weight:600;margin-top:4px">${esc(tr.contact)}</div></div>` : ""}
    <div class="row" style="flex-wrap:wrap">${e.teams.filter(t => teams.includes(t)).map(t => `<button class="btn small ghost" data-conv="team:${t}">Tchat ${esc(T(t).name)}</button>`).join("")}</div>`;
}
function bringBlock(tr) {
  const id = tr.id, items = itemsOf(id), t = items.length;
  if (isBureau() || (canPlan() && !concerned(tr).length)) {
    const e = eventOf(tr), ath = athletes().filter(a => e.teams.includes(a.team_id));
    const ready = ath.filter(a => t && packedOf(id, a.id).length === t).length;
    // Un membre du bureau qui a un enfant (ou qui est athlète) coche aussi son propre sac
    return (concerned(tr).length && t ? packBlock(tr) : "") + `<div class="card stack"><h2>${concerned(tr).length ? "Liste du déplacement" : "À emporter"}</h2>
      <p class="muted" style="margin:0;font-size:13px">Chaque athlète ou parent coche ces cases en préparant le sac. Tu peux ajouter ou retirer des affaires.</p>
      <div>${items.map(i => `<div class="check"><input type="checkbox" disabled aria-hidden="true" tabindex="-1"><span>${esc(i.label)}</span><button class="x" data-delitem="${i.id}" aria-label="Retirer ${esc(i.label)}">×</button></div>`).join("") || '<div class="muted">Aucune affaire dans la liste.</div>'}</div>
      <form id="addbring" class="row" style="gap:6px"><input id="brTxt" class="search" placeholder="Ex : Crème solaire, coussin…" aria-label="Nouvelle affaire"><button class="btn small">Ajouter</button></form>
      <div class="eyebrow" style="margin-top:6px">Sacs prêts : ${ready}/${ath.length}</div>
      ${ath.map(a => { const n = packedOf(id, a.id).length; return `<div class="row" style="font-size:13.5px"><span style="flex:1;min-width:0">${esc(a.full_name)}</span><span class="bar" style="width:90px"><i style="width:${t ? n / t * 100 : 0}%"></i></span><span style="width:34px;text-align:right;font-variant-numeric:tabular-nums">${n}/${t}</span></div>`; }).join("")}
    </div>`;
  }
  return packBlock(tr);
}
function packBlock(tr) {
  const id = tr.id, items = itemsOf(id), t = items.length;
  const c = concerned(tr); if (!c.length || !t) return "";
  const sel = c.find(a => a.id === S.packFor) || c[0];
  const done = new Set(packedOf(id, sel.id)), n = done.size;
  return `<div class="card stack"><div class="row" style="justify-content:space-between"><h2>À emporter</h2>${n === t ? '<span class="tag ok">Sac prêt ✓</span>' : `<span class="tag warn">${t - n} à préparer</span>`}</div>
    ${c.length > 1 ? `<div class="packtabs">${c.map(a => `<button class="chip" data-packfor="${a.id}" aria-pressed="${a.id === sel.id}">Sac de ${esc(first(a.full_name))} · ${packedOf(id, a.id).length}/${t}</button>`).join("")}</div>` : ""}
    <div class="row" style="gap:10px"><span class="bar" style="flex:1"><i style="width:${n / t * 100}%"></i></span><span style="font-weight:700;font-variant-numeric:tabular-nums">${n}/${t}</span></div>
    <div>${items.map(i => `<label class="check ${done.has(i.id) ? "done" : ""}"><input type="checkbox" data-pack="${sel.id}|${i.id}" ${done.has(i.id) ? "checked" : ""}><span>${esc(i.label)}</span></label>`).join("")}</div>
    <p class="muted" style="margin:0;font-size:12.5px">${c.length > 1 ? "Une liste par enfant." : "Coche au fur et à mesure que tu prépares ton sac."} Le bureau voit qui a terminé.</p>
    ${canPlan() && !isBureau() ? `<form id="addbring" class="row" style="gap:6px"><input id="brTxt" class="search" placeholder="Ajouter une affaire pour tous" aria-label="Nouvelle affaire"><button class="btn small">Ajouter</button></form>` : ""}
  </div>`;
}

/* ============ Documents ============ */
function docsOf(aid) { return D.docs.filter(d => d.athlete_id === aid); }
function docsView() {
  if (isBureau() && !S.docFor) return bureauDocs();
  const kids = isBureau() ? [P(S.docFor)] : myAthletes();
  if (!kids.length) return `<div class="empty">${me.role === "coach" ? "Les dossiers des athlètes sont suivis par le bureau." : "Aucun enfant n'est encore relié à ton compte. Demande au bureau de le faire."}</div>`;
  const sel = kids.find(a => a.id === S.docFor) || kids[0], d = docsOf(sel.id);
  const have = DOC_TYPES.filter(t => d.some(x => x.doc_type === t)).length;
  const known = DOC_GROUPS.flatMap(g => g[1]);
  const typeOf = x => known.includes(x.doc_type) ? x.doc_type : "Autre document";
  const row = t => {
    const files = d.filter(x => typeOf(x) === t), req = DOC_TYPES.includes(t);
    return `<div class="doc" style="align-items:flex-start;flex-wrap:wrap">
      <span class="file" style="flex:none"><span class="fi" style="${files.length ? "background:var(--ok-soft);color:var(--ok)" : ""}">${I.doc}</span></span>
      <span class="txt"><b>${esc(t)}${req ? ' <span class="muted" style="font-weight:500;font-size:12px">· obligatoire</span>' : ""}</b>
        ${files.map(f => `<span class="row" style="gap:6px;flex-wrap:nowrap"><button class="link" style="font-size:13px;padding:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%" data-open="${esc(f.file_path)}">${esc(f.file_name)}</button>
          ${(f.uploaded_by === me.id || isBureau()) ? (S.confirmDoc === f.id ? `<button class="btn small danger" data-deldoc="${f.id}">Supprimer</button>` : `<button class="x" style="border:0;background:none;color:var(--muted);font-size:17px" data-askdeldoc="${f.id}" aria-label="Supprimer ${esc(f.file_name)}">×</button>`) : ""}</span>
          <small>${fmtDate(f.created_at)} · ${esc(first(P(f.uploaded_by).full_name))}</small>`).join("") || `<small>${req ? "Pas encore envoyé" : "Facultatif"}</small>`}
      </span>
      ${isBureau() ? (req ? (files.length ? '<span class="tag ok">Reçu</span>' : '<span class="tag warn">Manquant</span>') : "") : `<span class="row" style="gap:6px;flex-basis:100%;padding-left:46px">
        <label class="btn small ${files.length ? "ghost" : ""}" title="Prendre en photo">📷 Photo<input type="file" hidden accept="image/*" capture="environment" data-docup="${sel.id}|${esc(t)}"></label>
        <label class="btn small ghost" title="Importer depuis le téléphone">📁 Fichier<input type="file" hidden accept="image/*,.pdf,.doc,.docx" data-docup="${sel.id}|${esc(t)}"></label></span>`}
    </div>`;
  };
  return `${isBureau() ? `<button class="btn small ghost" data-docback style="align-self:flex-start">‹ Tous les athlètes</button>` : `<div class="notice">${I.lock}<span>Ces documents ne sont visibles que par <b>le bureau</b>${me.role === "parent" ? " et les parents de l'enfant" : ""}. Prends-les en photo ou importe-les depuis ton téléphone (photo, PDF ou Word). Pour un recto-verso, envoie les deux photos dans la même catégorie.</span></div>`}
    ${kids.length > 1 ? `<div class="chips">${kids.map(a => `<button class="chip" data-docfor="${a.id}" aria-pressed="${a.id === sel.id}"><span class="dot" style="background:${T(a.team_id).color}"></span>${esc(first(a.full_name))}</button>`).join("")}</div>` : ""}
    <div class="card stack">
      <div class="row" style="justify-content:space-between"><h2>Dossier de ${esc(first(sel.full_name))}</h2>${have === DOC_TYPES.length ? '<span class="tag ok">Complet</span>' : `<span class="tag warn">${DOC_TYPES.length - have} manquant${DOC_TYPES.length - have > 1 ? "s" : ""}</span>`}</div>
      <div class="row" style="gap:10px"><span class="bar" style="flex:1"><i style="width:${have / DOC_TYPES.length * 100}%"></i></span><span style="font-weight:700;font-variant-numeric:tabular-nums">${have}/${DOC_TYPES.length}</span></div>
      <span class="muted" style="font-size:13px">Documents obligatoires envoyés</span>
    </div>
    ${DOC_GROUPS.map(([g, types]) => `<div class="card stack"><h2>${esc(g)}</h2><div>${types.map(row).join("")}</div></div>`).join("")}`;
}
function bureauDocs() {
  const ath = athletes();
  const missing = a => DOC_TYPES.filter(x => !docsOf(a.id).some(y => y.doc_type === x));
  const complete = ath.filter(a => !missing(a).length).length;
  return `<div class="card"><div class="eyebrow">Dossiers complets</div><div style="font-family:var(--display);font-size:28px;font-weight:800">${complete}/${ath.length}</div></div>
    ${D.allTeams.map(t => { const l = ath.filter(a => a.team_id === t.id); if (!l.length) return "";
      return `<div class="daylabel">Équipe ${esc(t.name)}</div><div class="list">${l.map(a => { const m = missing(a), n = DOC_TYPES.length - m.length;
        return `<button class="item" data-docfor="${a.id}">${avatar(a, 36)}<span class="txt"><span class="t1">${esc(a.full_name)} ${consentTag(a.id)}</span><span class="t2">${m.length ? "Manque : " + esc(m.join(", ")) : "Dossier complet"}</span></span><span class="tag ${m.length ? "warn" : "ok"}">${n}/${DOC_TYPES.length}</span></button>`; }).join("")}</div>`; }).join("") || `<div class="empty">Aucun athlète pour l'instant.</div>`}`;
}
// Réduit les photos du téléphone (souvent 3 à 8 Mo) avant l'envoi
async function shrink(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 600e3) return file;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(res => c.toBlob(res, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch (e) { return file; }
}
async function uploadDoc(aid, type, file) {
  file = await shrink(file);
  const path = `documents/${aid}/${Date.now()}-${safeName(file.name)}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined });
  if (error) throw error;
  const { data, error: e2 } = await sb.from("documents").insert({ athlete_id: aid, doc_type: type, file_path: path, file_name: file.name, file_size: file.size, file_type: file.type, uploaded_by: me.id }).select().single();
  if (e2) throw e2;
  D.docs.push(data);
}

/* ============ Bureau ============ */
/* Doublons : un même enfant saisi deux fois */
const plainName = t => (t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[-']/g, " ").replace(/\s+/g, " ").trim();
const kidLike = p => p.role !== "parent" && (isAth(p) || p.managed || (p.role === "pending" && p.wish === "athlete"));
function looksSame(a, b) {
  const x = plainName(a.full_name).split(" "), y = plainName(b.full_name).split(" ");
  if (x.join(" ") === y.join(" ") || x.slice().reverse().join(" ") === y.join(" ")) return true;
  if (x[0] !== y[0] || x[0].length < 2) return false;
  const rx = x.slice(1).join(" "), ry = y.slice(1).join(" ");
  if (a.birth_date && a.birth_date === b.birth_date) return true;
  if (!rx || !ry) return false;
  return rx.startsWith(ry) || ry.startsWith(rx) || rx.slice(0, 3) === ry.slice(0, 3);
}
function dupPairs() {
  const ign = store.get("pau-notdup", []), l = Object.values(D.P).filter(kidLike), out = [];
  for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++)
    if (looksSame(l[i], l[j]) && !ign.includes([l[i].id, l[j].id].sort().join("|"))) out.push([l[i], l[j]]);
  return out;
}
function dupCard(p) {
  return `<div class="stack" style="gap:4px;flex:1;min-width:140px"><div class="row" style="gap:8px">${avatar(p, 36)}<b>${esc(p.full_name)}</b></div>
    <span class="muted" style="font-size:12.5px">${p.team_id ? esc(T(p.team_id).name) : "Sans équipe"}${p.birth_date ? " · né·e le " + fmtDate(p.birth_date + "T12:00:00") : " · date de naissance inconnue"}<br>
    ${p.managed ? "Sans compte" : "A son propre compte"}${p.role === "pending" ? " · en attente" : ""} · parents : ${parentsOf(p.id).map(x => esc(first(x.full_name))).join(", ") || "aucun"}</span></div>`;
}
// Ce que le doublon apporte à la fiche gardée (informations qui manquent)
function mergeGains(k, d) {
  const out = [], pk = PV(k.id), pd = PV(d.id), nk = plainName(k.full_name), nd = plainName(d.full_name);
  if (!nk || (nd.length > nk.length && nd.startsWith(nk))) out.push("nom complet : " + esc(d.full_name));
  if (!k.birth_date && d.birth_date) out.push("date de naissance : " + fmtDate(d.birth_date + "T12:00:00"));
  if (!k.team_id && d.team_id) out.push("équipe : " + esc(T(d.team_id).name));
  if (!k.photo_path && d.photo_path) out.push("photo");
  if (!pk.gender && pd.gender) out.push("sexe");
  if (!pk.phone && pd.phone) out.push("téléphone");
  if (!pk.emergency_name && pd.emergency_name) out.push("contact d'urgence : " + esc(pd.emergency_name));
  if (!pk.emergency_phone && pd.emergency_phone) out.push("téléphone d'urgence");
  if (pk.image_consent == null && pd.image_consent != null) out.push("droit à l'image : " + (pd.image_consent ? "accepte" : "refuse"));
  else if (pk.image_consent === true && pd.image_consent === false) out.push("droit à l'image : refuse (le refus l'emporte)");
  const np = parentsOf(d.id).filter(x => !parentsOf(k.id).some(y => y.id === x.id));
  if (np.length) out.push("parent" + (np.length > 1 ? "s" : "") + " : " + np.map(x => esc(x.full_name)).join(", "));
  return out;
}
function mergeConfirm(keep, dup) {
  const g = mergeGains(keep, dup);
  return `<div class="stack" style="gap:8px;border:1px solid var(--gold);border-radius:12px;padding:10px 12px;background:var(--accent-soft)">
    <span style="font-size:13.5px">On garde <b>${esc(keep.full_name)}</b>${keep.team_id ? " (" + esc(T(keep.team_id).name) + ")" : ""}. La fiche <b>${esc(dup.full_name)}</b> est supprimée : ses absences, documents et inscriptions aux déplacements passent sur la fiche gardée.</span>
    <span style="font-size:13.5px">${g.length ? `<b>Ajouté à la fiche gardée :</b><br>• ${g.join("<br>• ")}` : "Rien ne manque sur la fiche gardée."}</span>
    <div class="row" style="gap:8px;flex-wrap:wrap"><button type="button" class="btn small" data-merge="${keep.id}|${dup.id}">Fusionner</button><button type="button" class="btn small ghost" data-mergepick="">Annuler</button></div></div>`;
}
function dupsView() {
  const pairs = dupPairs(), pick = S.mergePick || "", kids = Object.values(D.P).filter(kidLike).sort((a, b) => a.full_name.localeCompare(b.full_name));
  const opts = sel => kids.map(a => `<option value="${a.id}" ${sel === a.id ? "selected" : ""}>${esc(a.full_name)}${a.team_id ? " · " + esc(T(a.team_id).name) : ""}${a.birth_date ? " · " + a.birth_date.split("-").reverse().join("/") : ""}</option>`).join("");
  const mk = S.mergeManual || {};
  return `<p class="muted" style="margin:0;font-size:13.5px">Un enfant saisi deux fois (par chaque parent, ou avec une faute dans le nom) : choisis la fiche à garder, l'autre est fusionnée dedans.</p>
    ${pairs.length ? pairs.map(([a, b]) => { const key = a.id + "|" + b.id;
      return `<div class="card stack"><div class="row" style="gap:12px;flex-wrap:wrap;align-items:flex-start">${dupCard(a)}${dupCard(b)}</div>
        ${pick === a.id + ">" + b.id ? mergeConfirm(a, b) : pick === b.id + ">" + a.id ? mergeConfirm(b, a)
        : `<div class="row" style="gap:6px;flex-wrap:wrap"><button type="button" class="btn small" data-mergepick="${a.id}>${b.id}">Garder la 1re</button><button type="button" class="btn small" data-mergepick="${b.id}>${a.id}">Garder la 2e</button><button type="button" class="btn small ghost" data-notdup="${key}">Pas un doublon</button></div>`}</div>`; }).join("")
      : `<div class="empty">Aucun doublon repéré automatiquement.</div>`}
    <div class="card stack"><h2>Fusionner deux fiches au choix</h2>
      <label class="field">Fiche à garder<select id="mgKeep"><option value="">Choisir…</option>${opts(mk.keep)}</select></label>
      <label class="field">Doublon à supprimer<select id="mgDup"><option value="">Choisir…</option>${opts(mk.dup)}</select></label>
      ${mk.keep && mk.dup && pick === mk.keep + ">" + mk.dup ? mergeConfirm(P(mk.keep), P(mk.dup)) : `<button type="button" class="btn small" data-mergemanual style="align-self:flex-start">Continuer</button>`}</div>`;
}
function bureauView() {
  const qs = (S.q || "").toLowerCase();
  const all = Object.values(D.P).filter(p => p.id !== me.id);
  const pending = all.filter(p => p.role === "pending" && (!p.managed || (parentsOf(p.id).length && parentsOf(p.id).every(x => x.role !== "pending"))));
  const askOf = p => p.managed ? "Enfant ajouté par " + parentsOf(p.id).map(x => x.full_name).join(", ") + (p.team_id ? " · " + T(p.team_id).name : "")
    : p.wish === "parent" ? "Parent" + (D.links.some(l => l.parent_id === p.id) ? " de " + D.links.filter(l => l.parent_id === p.id).map(l => first(P(l.athlete_id).full_name)).join(", ") : "")
    : p.wish === "athlete" ? "Athlète" + (p.team_id ? " · " + T(p.team_id).name : "") : "Coach, bureau ou autre";
  const groups = [["Bureau", all.filter(p => p.role === "bureau")], ["Coachs", all.filter(p => p.role === "coach")],
    ...D.allTeams.map(t => ["Équipe " + t.name + (t.active === false ? " (en pause)" : ""), [...all.filter(p => isAth(p) && p.team_id === t.id), ...all.filter(p => p.role === "parent" && childrenOf(p.id).some(c => c.team_id === t.id))]]),
    ["Sans équipe ni enfant relié", all.filter(p => (p.role === "athlete" && !p.team_id) || (p.role === "parent" && !childrenOf(p.id).length))]];
  return `
    ${pending.length ? `<div class="card stack" style="border-color:var(--gold)"><h2>${pending.length} compte${pending.length > 1 ? "s" : ""} à valider</h2>
      <div class="list">${pending.map(p => `<button class="item" data-member="${p.id}">${avatar(p, 36)}<span class="txt"><span class="t1">${esc(p.full_name || "Sans nom")}</span><span class="t2">Demande : ${esc(askOf(p))}</span></span><span class="tag warn">Valider</span></button>`).join("")}</div></div>` : ""}
    <div class="grid2">
      <button class="card" data-goview="annonce" style="text-align:left;display:flex;flex-direction:column;gap:6px;border-color:var(--gold)"><span style="color:var(--accent)">${I.mega}</span><b>Annonce à toutes les équipes</b><span class="muted" style="font-size:13px">Publiée dans chaque tchat d'équipe</span></button>
      <button class="card" data-goview="addEvent" style="text-align:left;display:flex;flex-direction:column;gap:6px"><span style="color:var(--accent)">${I.cal}</span><b>Ajouter au planning</b><span class="muted" style="font-size:13px">Entraînement ou compétition</span></button>
    </div>
    <div class="card stack"><h2>Équipes de la saison</h2>
      <div class="chips" style="flex-wrap:wrap">${D.allTeams.map(t => `<button type="button" class="chip" data-teamactive="${t.id}" aria-pressed="${t.active !== false}"><span class="dot" style="background:${t.active === false ? "var(--line)" : t.color}"></span>${esc(t.name)}${t.active === false ? " · en pause" : ""}</button>`).join("")}</div>
      <span class="muted" style="font-size:12.5px">Touche une équipe pour la mettre en pause ou la réactiver. Une équipe en pause disparaît des listes, du planning, de l'inscription et des tchats. Rien n'est effacé.</span></div>
    ${(() => { const n = dupPairs().length; return `<button class="card" data-goview="dups" style="text-align:left;display:flex;gap:10px;align-items:center${n ? ";border-color:var(--gold)" : ""}"><span style="color:var(--accent)">${I.user}</span><span style="flex:1"><b>Enfants en double</b><br><span class="muted" style="font-size:13px">${n ? n + " doublon" + (n > 1 ? "s" : "") + " possible" + (n > 1 ? "s" : "") + " à vérifier" : "Fusionner deux fiches d'un même enfant"}</span></span><span class="muted">›</span></button>`; })()}
    <div class="eyebrow">Membres du club · touche un nom pour lui écrire</div>
    <input class="search" id="q" placeholder="Rechercher un nom…" aria-label="Rechercher">
    ${groups.map(([g, l]) => { l = l.filter(p => p.full_name.toLowerCase().includes(qs)); if (!l.length) return "";
      return `<div class="daylabel">${esc(g)}</div><div class="list">${l.map(p => `<div class="item"><button ${p.managed ? `data-member="${p.id}"` : `data-conv="dm:${p.id}"`} style="display:flex;gap:12px;align-items:center;flex:1;min-width:0;border:0;background:none;padding:0;text-align:left;color:inherit">${avatar(p, 36)}<span class="txt"><span class="t1">${esc(p.full_name)}</span><span class="t2">${esc(roleLabelFull(p))}${p.managed ? " · sans compte" : ""}</span>${consentTag(p.id)}</span></button><button class="btn small ghost" data-member="${p.id}">Fiche</button>${p.managed ? "" : `<button class="btn small" data-conv="dm:${p.id}" aria-label="Message privé à ${esc(p.full_name)}">💬</button>`}</div>`).join("")}</div>`; }).join("")}`;
}
function memberView(id) {
  const p = P(id);
  if (!S.memberEmail || S.memberEmail.id !== id) { S.memberEmail = { id, email: "…" }; sb.from("profile_private").select("email").eq("id", id).maybeSingle().then(({ data }) => { S.memberEmail = { id, email: (data && data.email) || "" }; const el = document.getElementById("mEmailTxt"); if (el) el.textContent = S.memberEmail.email; }); }
  const role = S.mRole || (p.role === "pending" && p.wish && !p.managed ? p.wish : p.role);
  const linked = D.links.filter(l => l.parent_id === id).map(l => l.athlete_id);
  const kids = new Set(S.mKids || linked);
  const kidList = [...new Map([...athletes(), ...linked.map(P)].map(a => [a.id, a])).values()].sort((a, b) => (kids.has(b.id) - kids.has(a.id)) || a.full_name.localeCompare(b.full_name));
  return `<form id="memberForm" class="stack">
    <div class="card stack"><div class="row">${avatar(p, 56)}<span><b>${esc(p.full_name || "Sans nom")}</b><br><span class="muted" id="mEmailTxt" style="font-size:13px">${esc(S.memberEmail.email)}</span></span></div></div>
    ${p.managed ? `<div class="notice">${I.user}<span>Enfant <b>sans compte</b> : ses parents indiquent ses absences et envoient ses documents. Parents : ${parentsOf(id).map(x => esc(x.full_name)).join(", ") || "aucun"}.</span></div>` : ""}
    ${p.role === "pending" && p.wish ? `<p class="muted" style="margin:0;font-size:13px">À l'inscription, cette personne s'est déclarée <b>${p.wish === "parent" ? "parent" : "athlète"}</b>. Vérifie les informations puis enregistre.</p>` : ""}
    ${nameFields("m", p.full_name)}
    <div class="row" style="gap:6px">${photoBtn(id, p.photo_path ? "📷 Changer la photo" : "📷 Ajouter une photo")}${consentTag(id)}</div>
    <div class="field">Sexe${genderPick("mGender", PV(id).gender, p.managed)}</div>
    ${consentPick("mConsent", PV(id).image_consent, "de son image")}
    ${p.managed ? "" : `<label class="field">Téléphone<input id="mPhone" type="tel" value="${esc(PV(id).phone || "")}"></label>`}
    ${role === "athlete" || isAth(p) ? `<div class="eyebrow">Personne à contacter en cas de problème</div>
      <div class="grid2"><label class="field">Nom<input id="mEmName" value="${esc(PV(id).emergency_name || "")}"></label><label class="field">Téléphone<input id="mEmPhone" type="tel" value="${esc(PV(id).emergency_phone || "")}"></label></div>
      <div class="card stack" style="gap:6px"><b style="font-size:14px">Contacts</b>${contactsOf(p)}</div>` : ""}
    <label class="field">Rôle<select id="mRole">
      ${[["pending", "En attente (aucun accès)"], ["athlete", "Athlète"], ["parent", "Parent"], ["coach", "Coach"], ["bureau", "Membre du bureau"]].map(([v, l]) => `<option value="${v}" ${role === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    ${["athlete", "bureau", "coach"].includes(role) ? `<label class="field">Date de naissance<input id="mBirth" type="date" value="${esc(p.birth_date || "")}"></label>` : ""}
    ${["athlete", "bureau", "coach"].includes(role) ? `<label class="field">${role === "athlete" ? "Équipe" : "Pratique aussi comme athlète dans l'équipe (facultatif)"}<select id="mTeam"><option value="">${role === "athlete" ? "Choisir…" : "Non, pas athlète"}</option>${teamsFor(p.team_id).map(t => `<option value="${t.id}" ${p.team_id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>` : ""}
    ${role === "coach" ? `<div class="field">Équipes entraînées<div class="chips" style="flex-wrap:wrap">${D.teams.map(t => `<label class="chip"><input type="checkbox" name="mct" value="${t.id}" ${coachTeamsOf(id).includes(t.id) ? "checked" : ""}> ${esc(t.name)}</label>`).join("")}</div><span class="muted" style="font-size:13px;font-weight:400">Le coach voit le planning, le tchat et l'appel de ces équipes.</span></div>` : ""}
    ${role === "bureau" ? `<label class="field">Fonction<input id="mTitle" value="${esc(p.title || "")}" placeholder="Président, trésorière, coach…"></label>` : ""}
    ${role === "parent" ? `<div class="field">Enfants (un ou plusieurs)<div class="card" style="padding:4px 12px">${kidList.map(a => `<label class="check"><input type="checkbox" name="mkid" value="${a.id}" ${kids.has(a.id) ? "checked" : ""}><span>${esc(a.full_name)}${a.birth_date ? ` <span class="muted" style="font-size:12.5px">né·e le ${fmtDate(a.birth_date + "T12:00:00")}</span>` : ""} ${a.team_id ? teamChip(a.team_id) : '<span class="tag warn">Sans équipe</span>'}${a.role === "pending" ? ' <span class="tag warn">nouveau</span>' : ""}${isLegal(id, a.id) ? ' <span class="tag ok">responsable légal</span>' : ""}${parentsOf(a.id).filter(x => x.id !== id).length ? ` <span class="muted" style="font-size:12.5px">· autre parent : ${parentsOf(a.id).filter(x => x.id !== id).map(x => esc(first(x.full_name))).join(", ")}</span>` : ""}</span></label>`).join("") || '<span class="muted">Aucun enfant pour l\'instant : ajoute-le ci-dessous.</span>'}</div>
      <span class="muted" style="font-size:12.5px;font-weight:400">Les enfants cochés et « nouveaux » sont validés en même temps que le parent.</span></div>
      <details class="card"><summary style="font-weight:700;cursor:pointer">＋ Ajouter un enfant</summary><div class="stack" style="margin-top:10px">
        <div class="grid2"><label class="field">Prénom<input id="akFirst"></label><label class="field">Nom<input id="akLast" value="${esc((p.full_name || "").trim().split(/\s+/).slice(1).join(" "))}"></label></div>
        <div class="grid2"><label class="field">Date de naissance<input id="akBirth" type="date"></label><label class="field">Équipe<select id="akTeam"><option value="">Choisir…</option>${D.teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label></div>
        <p class="muted" style="margin:0;font-size:12.5px">Si l'enfant existe déjà (même prénom, nom et date de naissance), le parent est simplement relié à lui.</p>
        <button type="button" class="btn small" data-addchild="${id}" style="align-self:flex-start">Ajouter l'enfant</button></div></details>` : ""}
    ${role !== "pending" ? (role === "bureau" ? `<p class="muted" style="margin:0;font-size:13px">Les membres du bureau peuvent toujours gérer le planning et les déplacements.</p>`
      : `<label class="check card" style="padding:10px 12px"><input type="checkbox" id="mPlan" ${p.can_plan ? "checked" : ""}><span><b>Peut gérer le planning</b><br><span class="muted" style="font-size:13px">Ajouter, modifier et supprimer les événements, compétitions et déplacements.</span></span></label>`) : ""}
    ${role === "athlete" ? `<p class="muted" style="margin:0;font-size:13px">Parents reliés : ${parentsOf(id).map(x => esc(x.full_name)).join(", ") || "aucun pour l'instant (à faire depuis la fiche du parent)"}.</p>` : ""}
    <button class="btn">Enregistrer</button>
    ${p.managed ? "" : `<button type="button" class="btn ghost" data-conv="dm:${id}">Envoyer un message privé</button>`}
    ${kidLike(p) ? `<button type="button" class="btn ghost" data-mergefrom="${id}">Fusionner avec une fiche en double</button>` : ""}
  </form>`;
}

function editEventView(id) {
  const e = D.events.find(x => x.id === id);
  if (!e) return `<div class="empty">Cet événement n'existe plus.</div>`;
  const tr = tripOfEvent(id);
  return `<form id="editev" class="stack">
    ${e.type === "comp" ? `<span class="tag comp" style="align-self:flex-start">Compétition</span>`
      : `<label class="field">Catégorie<select id="eeType">${["train", "camp", "event"].map(t => `<option value="${t}" ${e.type === t ? "selected" : ""}>${EV_TYPES[t]}</option>`).join("")}</select></label>`}
    <label class="field">Titre<input id="eeTitle" value="${esc(e.title)}" required></label>
    <div class="field">Équipes<div class="chips" style="flex-wrap:wrap">${D.teams.map(t => `<label class="chip"><input type="checkbox" name="eetm" value="${t.id}" ${e.teams.includes(t.id) ? "checked" : ""}> ${esc(t.name)}</label>`).join("")}</div></div>
    <label class="field">Date<input id="eeDate" type="date" value="${e.date}" required></label>
    <div class="grid2"><label class="field">Début<input id="eeS" type="time" value="${hm(e.start_time)}" required></label><label class="field">Fin<input id="eeE" type="time" value="${hm(e.end_time)}" required></label></div>
    <label class="check"><input type="checkbox" id="eeNoTime" ${e.no_time ? "checked" : ""}><span>Horaire à confirmer</span></label>
    <label class="field">Lieu<input id="eePlace" value="${esc(e.place)}" required></label>
    ${seriesOf(e).length > 1 ? `<div class="field">Appliquer la modification à
      <label class="check card" style="padding:10px 12px"><input type="radio" name="eeScope" value="one" checked><span>Cet entraînement seulement</span></label>
      <label class="check card" style="padding:10px 12px"><input type="radio" name="eeScope" value="next"><span>Cet entraînement et les suivants (${seriesOf(e).length} au total)<br><span class="muted" style="font-size:13px;font-weight:400">Si tu changes la date, tous les suivants sont décalés du même nombre de jours.</span></span></label></div>` : ""}
    ${tr ? `<p class="muted" style="margin:0;font-size:13px">Le départ, les trajets et le programme se modifient dans la page du déplacement.</p><button type="button" class="btn ghost" data-trip="${tr.id}">Ouvrir le déplacement</button>` : ""}
    <button class="btn">Enregistrer les modifications</button></form>`;
}
function annonceView() {
  return `<div class="notice">${I.mega}<span>Le message sera publié dans <b>chaque tchat d'équipe choisi</b>. Pour une information personnelle, utilise plutôt un message privé.</span></div>
  <form id="annonce" class="stack">
    <div class="field">Équipes concernées<div class="chips" style="flex-wrap:wrap">${D.teams.map(t => `<label class="chip"><input type="checkbox" name="tm" value="${t.id}" checked> ${esc(t.name)}</label>`).join("")}</div></div>
    <label class="field">Message<textarea id="annTxt" rows="5" placeholder="Ex : pas d'entraînement pendant les vacances de Noël…" required></textarea></label>
    <button class="btn">Publier l'annonce</button></form>`;
}
function addEventView() {
  const ty = EV_TYPES[S.evType] ? S.evType : "train", comp = ty === "comp", tbd = !!S.evTbd;
  const ph = { train: "", comp: "Ex : Championnat régional", camp: "Ex : Camp tumbling avec Lauriane", event: "Ex : Gala, showcase…" }[ty];
  return `<form id="addev" class="stack">
    <label class="field">Catégorie<select id="evType">${Object.entries(EV_TYPES).map(([k, l]) => `<option value="${k}" ${ty === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label class="field">Titre<input id="evTitle" value="${ty === "train" ? "Entraînement" : ""}" placeholder="${ph}" required></label>
    <div class="field">Équipes<div class="chips" style="flex-wrap:wrap">${D.teams.map(t => `<label class="chip"><input type="checkbox" name="evtm" value="${t.id}"> ${esc(t.name)}</label>`).join("")}</div></div>
    <label class="field">Date<input id="evDate" type="date" value="${addDays(todayIso(), 7)}" required></label>
    <div class="grid2"><label class="field">Début<input id="evS" type="time" value="${tbd ? "14:00" : comp ? "09:00" : "18:00"}" required></label><label class="field">Fin<input id="evE" type="time" value="${tbd ? "17:00" : comp ? "18:00" : "20:00"}" required></label></div>
    ${ty !== "train" ? `<label class="check"><input type="checkbox" id="evNoTime" ${tbd ? "checked" : ""}><span>Horaire à confirmer (mis de 14h00 à 17h00)</span></label>` : ""}
    <label class="field">Lieu<input id="evPlace" value="${comp ? "" : "Salle Sainte-Ursule, Pau"}" required></label>
    ${comp ? `<div class="stack"><div class="eyebrow">Déplacement</div>
      <p class="muted" style="margin:0;font-size:13px">Par défaut : départ la veille au soir et retour dans la nuit suivante. Change les dates pour un déplacement plus long.</p>
      <div class="grid2"><label class="field">Jour de départ<input id="trDate" type="date" value="${addDays(addDays(todayIso(), 7), -1)}"></label><label class="field">Heure de départ<input id="trTime" type="time" value="20:00"></label></div>
      <div class="grid2"><label class="field">Jour de retour<input id="trRDate" type="date" value="${addDays(addDays(todayIso(), 7), 1)}"></label><label class="field">Heure de retour<input id="trRet" value="vers 3h du matin"></label></div>
      <label class="field">Transport principal<select id="trMode">${Object.keys(MODES).map(m => `<option>${m}</option>`).join("")}</select></label>
      <label class="field">Lieu de rendez-vous<input id="trPlace" value="Salle Sainte-Ursule, Pau"></label>
      <label class="field">Précisions sur le transport<input id="trTransport" placeholder="Bus du club, vol Air France…"></label>
      <label class="field">Hébergement (si nuit sur place)<input id="trLodging" placeholder="Hôtel, adresse…"></label>
      <label class="field">Responsable et téléphone<input id="trContact" value="${esc(me.full_name)}"></label>
      <p class="muted" style="margin:0;font-size:13px">Une liste « À emporter » de base est créée, tu pourras la modifier dans le déplacement.</p></div>`
    : ty === "train" ? `<label class="check"><input type="checkbox" id="evRepeat"><span>Répéter chaque semaine jusqu'au</span></label><input id="evUntil" type="date" class="search" value="2027-06-30">
      <p class="muted" style="margin:0;font-size:12.5px">Les vacances scolaires sont sautées automatiquement.</p>` : ""}
    <button class="btn">Ajouter au planning</button></form>`;
}

/* ============ Actions ============ */
function bind() {
  const on = (sel, fn, evt = "onclick") => $app.querySelectorAll(sel).forEach(el => el[evt] = ev => fn(el, ev));
  on("[data-cat]", b => { S.cat = b.dataset.cat; S.limit = 40; render(); });
  on("[data-filter]", b => { S.filter = b.dataset.filter; S.limit = 40; render(); });
  on("[data-more]", () => { S.limit += 60; render(0); });
  on("[data-trip]", b => { S.editTrip = null; go("trips", { kind: "trip", id: b.dataset.trip }); });
  on("[data-conv]", b => { S.loadedConv = null; go("chats", { kind: "conv", key: b.dataset.conv }); });
  on("[data-goview]", b => { S.evType = "train"; go("bureau", { kind: b.dataset.goview }); });
  on("[data-member]", b => { S.mRole = null; S.mKids = null; go("bureau", { kind: "member", id: b.dataset.member }); });
  on("[data-askdelnews]", b => { S.confirmNews = b.dataset.askdelnews; render(0); });
  on("[data-delnews]", async b => {
    const n = D.news.find(x => x.id === b.dataset.delnews); if (!n) return;
    try { await q(sb.from("news").delete().eq("id", n.id).select()); if (n.image_path) await sb.storage.from(BUCKET).remove([n.image_path]);
      D.news = D.news.filter(x => x.id !== n.id); S.confirmNews = null; render(0); toast("Actualité supprimée"); } catch (e) { fail(e); }
  });
  on("[data-pinnews]", async b => {
    const n = D.news.find(x => x.id === b.dataset.pinnews); if (!n) return;
    try { const [row] = await q(sb.from("news").update({ pinned: !n.pinned }).eq("id", n.id).select()); Object.assign(n, row); render(0); } catch (e) { fail(e); }
  });
  on("[data-contacts]", () => { S.cq = ""; go("chats", { kind: "contacts" }); });
  on("[data-roll]", b => go("planning", { kind: "roll", id: b.dataset.roll }));
  on("[data-att]", async b => {
    const [eid, aid, st] = b.dataset.att.split("|");
    try { await saveAtt(eid, aid, { status: st }); render(0); toast(st === "present" ? "Présence notée" : "Absence notée : tu peux ajouter un motif et un justificatif"); } catch (e) { fail(e); }
  });
  on("[data-why]", async inp => { const [eid, aid] = inp.dataset.why.split("|"); try { await saveAtt(eid, aid, { reason: inp.value.trim() }); toast("Motif enregistré"); } catch (e) { fail(e); } }, "onchange");
  on("[data-attfile]", async inp => {
    let f = inp.files[0]; if (!f) return; const [eid, aid] = inp.dataset.attfile.split("|");
    if (f.size > 10 * 1024 * 1024) return toast("Fichier trop lourd (10 Mo maximum).");
    toast("Envoi en cours…");
    try { f = await shrink(f); const path = `absences/${aid}/${Date.now()}-${safeName(f.name)}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || undefined }); if (error) throw error;
      await saveAtt(eid, aid, { file_path: path, file_name: f.name }); render(0); toast("Justificatif envoyé"); } catch (e) { fail(e, "L'envoi n'a pas marché. Réessaie."); }
  }, "onchange");
  on("[data-manageteams]", () => go("planning", { kind: "teams" }));
  const tq = document.getElementById("tq"); if (tq) { tq.value = S.tq || ""; tq.oninput = () => { S.tq = tq.value; render(0); const t = document.getElementById("tq"); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }; }
  on("[data-savemoves]", async () => {
    const ch = [...$app.querySelectorAll("[data-move]")].filter(s => (s.value || null) !== (P(s.dataset.move).team_id || null));
    if (!ch.length) return toast("Aucun changement.");
    try { for (const s of ch) await q(sb.rpc("set_athlete_team", { a: s.dataset.move, t: s.value || null }));
      await loadAll(); render(0); toast(ch.length > 1 ? `${ch.length} athlètes changés d'équipe` : "Changement d'équipe enregistré"); } catch (e) { fail(e); }
  });
  on("[data-decide]", async b => { const [id, ok] = b.dataset.decide.split("|");
    try { await q(sb.rpc("decide_team_request", { r: id, ok: ok === "1" })); await loadAll(); render(0); toast(ok === "1" ? "Changement d'équipe accepté" : "Demande refusée"); } catch (e) { fail(e); } });
  on("[data-sendreq]", async b => { const aid = b.dataset.sendreq, sel = $app.querySelector(`[data-reqteam="${aid}"]`), to = sel && sel.value;
    if (!to) return toast("Choisis la nouvelle équipe.");
    try { const [r] = await q(sb.from("team_requests").insert({ athlete_id: aid, from_team: P(aid).team_id || null, to_team: to, requested_by: me.id, status: "pending" }).select());
      D.teamReqs = [r].concat(D.teamReqs || []); render(0); toast("Demande envoyée au coach"); } catch (e) { fail(e); } });
  on("[data-cancelreq]", async b => { try { await q(sb.from("team_requests").update({ status: "cancelled" }).eq("id", b.dataset.cancelreq).select());
      D.teamReqs = (D.teamReqs || []).map(r => r.id === b.dataset.cancelreq ? { ...r, status: "cancelled" } : r); render(0); toast("Demande annulée"); } catch (e) { fail(e); } });
  on("[data-mergepick]", b => { S.mergePick = b.dataset.mergepick; render(0); });
  on("[data-notdup]", b => { const l = store.get("pau-notdup", []); l.push(b.dataset.notdup.split("|").sort().join("|")); store.set("pau-notdup", l); render(0); });
  on("[data-mergefrom]", b => { S.mergeManual = { keep: b.dataset.mergefrom }; S.mergePick = ""; go("bureau", { kind: "dups" }); });
  on("[data-mergemanual]", () => { const k = val("mgKeep"), d = val("mgDup"); S.mergeManual = { keep: k, dup: d };
    if (!k || !d) return toast("Choisis les deux fiches."); if (k === d) return toast("Choisis deux fiches différentes.");
    S.mergePick = k + ">" + d; render(0); });
  on("[data-merge]", async b => { const [k, d] = b.dataset.merge.split("|"), name = P(d).full_name;
    try { await q(sb.rpc("merge_profiles", { keep: k, dup: d })); S.mergePick = ""; S.mergeManual = null; await loadAll(); render(0); toast("Fiches fusionnées : " + name + " a été rattaché·e à " + P(k).full_name); }
    catch (e) { fail(e, e && e.message && /compte|bureau|athlètes|différentes/.test(e.message) ? e.message : "La fusion n'a pas marché. La base est-elle à jour (mise à jour 14) ?"); } });
  on("[data-askrmkid]", b => { S.rmKid = b.dataset.askrmkid || null; render(0); });
  on("[data-rmkid]", async b => {
    const c = P(b.dataset.rmkid);
    try { const r = await q(sb.rpc("remove_child", { a: c.id })); S.rmKid = null;
      await loadAll(); render(0); toast(r === "deleted" ? c.full_name + " a été supprimé·e" : c.full_name + " est retiré·e de ton compte"); }
    catch (e) { fail(e, "Impossible de retirer l'enfant. La base est-elle à jour (mise à jour 13) ?"); }
  });
  on("[data-linkdecide]", async b => { const [id, ok] = b.dataset.linkdecide.split("|");
    try { await q(sb.rpc("decide_link_request", { r: id, ok: ok === "1" })); await loadAll(); render(0);
      toast(ok === "1" ? "Parent relié à l'enfant" : "Demande retirée"); } catch (e) { fail(e); } });
  on("[data-claimkid]", async b => {
    try { const r = await q(sb.rpc("request_link", { a: b.dataset.claimkid })); S.mk = null; S.kidMatches = null;
      await loadAll(); render(0); toast(r === "linked" ? "Enfant relié à ton compte" : "Demande envoyée au bureau : il va te relier à ton enfant"); } catch (e) { fail(e); }
  });
  on("[data-addmykid]", async b => {
    const g = id => (document.getElementById(id) || {}).value || "";
    const gd0 = $app.querySelector("[name=mkGender]:checked");
    S.mk = { first: g("mkFirst"), last: g("mkLast"), birth: g("mkBirth"), team: g("mkTeam"), gender: gd0 ? gd0.value : null };
    if (!g("mkFirst").trim() || !g("mkLast").trim()) return toast("Indique le prénom et le nom de ton enfant.");
    // Contrôle : un enfant qui ressemble est-il déjà inscrit ?
    if (b.dataset.addmykid !== "force") {
      let found = [];
      try { found = (await q(sb.rpc("similar_children", { p_first: g("mkFirst"), p_last: g("mkLast"), p_birth: g("mkBirth") || null, p_team: g("mkTeam") || null }))) || []; } catch (e) { found = []; }
      if (found.length) { S.kidMatches = found; render(0); return; }
    }
    S.kidMatches = null;
    try { const cid = await q(sb.rpc("add_child", { p_parent: me.id, p_first: g("mkFirst"), p_last: g("mkLast"), p_birth: g("mkBirth") || null, p_team: g("mkTeam") || null }));
      const gd = $app.querySelector("[name=mkGender]:checked"); if (cid && gd) await savePriv(cid, { gender: gd.value }).catch(() => {});
      S.mk = null; await loadAll(); render(0); toast(isBureau() ? "Enfant ajouté" : "Enfant ajouté : le bureau va valider"); } catch (e) { fail(e, e && /déjà inscrit/.test(e.message || "") ? "Cet enfant est déjà inscrit : demande au bureau de te relier à lui." : undefined); }
  });
  on("[data-linkmykid]", async () => {
    const a = (document.getElementById("mkLink") || {}).value; if (!a) return toast("Choisis l'athlète.");
    try { await q(sb.from("parent_links").insert({ parent_id: me.id, athlete_id: a }).select()); D.links.push({ parent_id: me.id, athlete_id: a }); render(0); toast("Enfant relié à ton compte"); } catch (e) { fail(e); }
  });
  on("[data-addchild]", async b => {
    const g = id => (document.getElementById(id) || {}).value || "", pid = b.dataset.addchild;
    if (!g("akFirst").trim() || !g("akLast").trim()) return toast("Indique le prénom et le nom de l'enfant.");
    try { S.mKids = [...$app.querySelectorAll("[name=mkid]:checked")].map(x => x.value);
      const cid = await q(sb.rpc("add_child", { p_parent: pid, p_first: g("akFirst"), p_last: g("akLast"), p_birth: g("akBirth") || null, p_team: g("akTeam") || null }));
      await loadAll(); if (cid && !S.mKids.includes(cid)) S.mKids.push(cid); render(0); toast("Enfant ajouté et relié au parent"); } catch (e) { fail(e, "Ça n'a pas marché. La base est-elle à jour (mise à jour 6) ?"); }
  });
  on("[data-addev]", () => { S.evType = "train"; go("planning", { kind: "addEvent" }); });
  on("[data-editev]", b => go("planning", { kind: "editEvent", id: b.dataset.editev }));
  on("[data-askdel]", b => { S.confirm = b.dataset.askdel; render(0); });
  on("[data-cancel]", () => { S.confirm = null; render(0); });
  on("[data-delev]", async b => { try { await q(sb.from("events").delete().eq("id", b.dataset.delev).select()); D.events = D.events.filter(e => e.id !== b.dataset.delev); S.confirm = null;
    if (S.view && S.view.kind === "trip") go("trips"); else render(0); toast("Supprimé du planning"); } catch (e) { fail(e); } });
  on("[data-photo]", async inp => {
    const f = inp.files[0], id = inp.dataset.photo; if (!f) return;
    toast("Envoi de la photo…");
    try { const sq = await squarePhoto(f), path = `avatars/${id}/${Date.now()}.jpg`;
      const { error } = await sb.storage.from(BUCKET).upload(path, sq, { contentType: "image/jpeg" }); if (error) throw error;
      const old = P(id).photo_path;
      await q(sb.rpc("set_photo", { a: id, p: path }));
      D.P[id] = { ...P(id), photo_path: path }; if (id === me.id) me.photo_path = path;
      if (old) sb.storage.from(BUCKET).remove([old]).catch(() => {});
      render(0); toast("Photo enregistrée"); } catch (e) { fail(e, "La photo n'a pas pu être envoyée."); }
  }, "onchange");
  on("[data-delseries]", async b => {
    const e = D.events.find(x => x.id === b.dataset.delseries), ids = seriesOf(e).map(x => x.id);
    try { for (const c of chunks(ids)) await q(sb.from("events").delete().in("id", c).select());
      D.events = D.events.filter(x => !ids.includes(x.id)); S.confirm = null; render(0); toast(`${ids.length} entraînements supprimés`); } catch (e) { fail(e); }
  });
  on("[data-msgmenu]", (b, ev) => { if (ev && ev.target.closest("[data-open], img.thumb, a")) return;
    const id = b.dataset.msgmenu; S.msgMenu = id && S.msgMenu !== id ? id : null; render(true); });
  on("[data-delmsg]", async b => { const [id, how] = b.dataset.delmsg.split("|"), m = D.msgs.find(x => x.id === id); if (!m) return; const key = convOf(m); S.msgMenu = null;
    try {
      if (how === "me") { await savePref(key, { hidden: [...(prefOf(key).hidden || []), id] }); render(true); toast("Message supprimé pour toi"); return; }
      if (m.file_path) await sb.storage.from(BUCKET).remove([m.file_path]).catch(() => {});
      await q(sb.from("messages").delete().eq("id", id).select());
      D.msgs = D.msgs.filter(x => x.id !== id); render(true); toast("Message supprimé pour tout le monde");
    } catch (e) { fail(e, how === "me" ? "Impossible de supprimer. La base est-elle à jour (mise à jour 16) ?" : undefined); } });
  on("[data-pushon]", async b => { b.disabled = true; try { await enablePush(); } catch (e) { fail(e, "Impossible d'activer les notifications."); } finally { b.disabled = false; } });
  on("[data-pushoff]", async () => { await disablePush(); render(0); toast("Notifications désactivées sur ce téléphone"); });
  on("[data-pushlater]", () => { store.set("pau-push-later", true); render(0); });
  on("[data-boards]", () => go("planning", { kind: "boards" }));
  on("[data-board]", b => { S.bday = null; S.confirmBoard = null; go("planning", { kind: "board", id: b.dataset.board }); });
  on("[data-newboard]", () => go("planning", { kind: "boardForm" }));
  on("[data-editboard]", b => go("planning", { kind: "boardForm", id: b.dataset.editboard }));
  on("[data-bday]", b => { S.bday = b.dataset.bday; render(0); });
  on("[data-askdelboard]", b => { S.confirmBoard = b.dataset.askdelboard || null; render(0); });
  const bw = document.getElementById("bWho"); if (bw) bw.onchange = () => { S.bwho = bw.value; render(0); };
  on("[data-delboard]", async b => { try { await q(sb.from("shift_boards").delete().eq("id", b.dataset.delboard).select());
      D.boards = D.boards.filter(x => x.id !== b.dataset.delboard); go("planning", { kind: "boards" }); toast("Permanence supprimée"); } catch (e) { fail(e); } });
  on("[data-shift]", async b => { const [bid, day, st, pid] = b.dataset.shift.split("|");
    try { const [r] = await q(sb.from("shift_signups").insert({ board_id: bid, day, start_time: st, person_id: pid }).select());
      D.shifts.push(r || { board_id: bid, day, start_time: st, person_id: pid }); render(0);
      toast((pid === me.id ? "Merci ! Tu es inscrit·e " : first(P(pid).full_name) + " est inscrit·e ") + fmtShort(day) + " à " + hhmm(st)); }
    catch (e) { fail(e, e && /complet|existe pas/.test(e.message || "") ? e.message : "L'inscription n'a pas marché. La base est-elle à jour (mise à jour 17) ?"); await loadAll(); render(0); } });
  on("[data-unshift]", async b => { const [bid, day, st, pid] = b.dataset.unshift.split("|");
    try { await q(sb.from("shift_signups").delete().eq("board_id", bid).eq("day", day).eq("start_time", st).eq("person_id", pid).select());
      D.shifts = D.shifts.filter(s => !(s.board_id === bid && s.day === day && hm(s.start_time) === st && s.person_id === pid)); render(0); toast("Inscription retirée"); } catch (e) { fail(e); } });
  on("[data-convarch]", async b => { const key = b.dataset.convarch, arch = isArchived(key) || (prefOf(key).archived_at && !msgsOf(key).length);
    try { await savePref(key, { archived_at: arch ? null : new Date().toISOString() });
      if (arch) { render(true); toast("Conversation désarchivée"); } else { go("chats"); toast("Conversation archivée : elle revient dès qu'un nouveau message arrive"); } }
    catch (e) { fail(e, "Impossible d'archiver. La base est-elle à jour (mise à jour 15) ?"); } });
  on("[data-convask]", b => { const [key, what] = b.dataset.convask.split("|"); S.convAsk = key ? { key, what } : null; render(); });
  on("[data-convdo]", async b => { const [key, what] = b.dataset.convdo.split("|"); S.convAsk = null;
    try {
      if (what === "clear") { await savePref(key, { cleared_at: new Date().toISOString() }); go("chats"); toast("Conversation vidée pour toi"); return; }
      const files = D.msgs.filter(m => convOf(m) === key && m.file_path).map(m => m.file_path);
      if (files.length) await sb.storage.from(BUCKET).remove(files).catch(() => {});
      await q(sb.rpc("delete_conv", { c: srvConv(key) }));
      D.msgs = D.msgs.filter(m => convOf(m) !== key); D.reads = (D.reads || []).filter(r => r.conv !== srvConv(key)); D.prefs = (D.prefs || []).filter(p => p.conv !== srvConv(key));
      go("chats"); toast("Conversation supprimée pour tout le monde");
    } catch (e) { fail(e, "La suppression n'a pas marché. La base est-elle à jour (mise à jour 15) ?"); } });
  const ab = $app.querySelector("[data-archbox]"); if (ab) ab.ontoggle = () => { S.showArch = ab.open; };
  on("[data-teamactive]", async b => { const id = b.dataset.teamactive, t = T(id), v = t.active === false;
    try { await q(sb.from("teams").update({ active: v }).eq("id", id).select()); await loadAll(); render(0); toast(v ? "Équipe " + t.name + " active cette saison" : "Équipe " + t.name + " mise en pause"); }
    catch (e) { fail(e, "Impossible de changer l'équipe. La base est-elle à jour (mise à jour 15) ?"); } });
  on("[data-readers]", b => { S.readersOpen = S.readersOpen === b.dataset.readers ? null : b.dataset.readers; render(true); });
  on("[data-open]", async b => { try { const u = await signedUrl(b.dataset.open); window.open(u, "_blank", "noopener"); } catch (e) { fail(e, "Impossible d'ouvrir ce fichier."); } });
  on("[data-packfor]", b => { S.packFor = b.dataset.packfor; render(0); });
  on("[data-docfor]", b => { S.docFor = b.dataset.docfor; render(); window.scrollTo(0, 0); });
  on("[data-askdeldoc]", b => { S.confirmDoc = b.dataset.askdeldoc; render(0); });
  on("[data-deldoc]", async b => {
    const doc = D.docs.find(x => x.id === b.dataset.deldoc); if (!doc) return;
    try { await q(sb.from("documents").delete().eq("id", doc.id).select()); await sb.storage.from(BUCKET).remove([doc.file_path]);
      D.docs = D.docs.filter(x => x.id !== doc.id); S.confirmDoc = null; render(0); toast("Document supprimé"); } catch (e) { fail(e); }
  });
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
  on("[data-delleg]", async b => { try { await q(sb.from("trip_legs").delete().eq("id", b.dataset.delleg).select()); D.legs = D.legs.filter(i => i.id !== b.dataset.delleg); render(0); } catch (e) { fail(e); } });
  on("[data-delstep]", async b => { try { await q(sb.from("trip_steps").delete().eq("id", b.dataset.delstep).select()); D.steps = D.steps.filter(i => i.id !== b.dataset.delstep); render(0); } catch (e) { fail(e); } });
  on("[data-docup]", async inp => {
    const f = inp.files[0]; if (!f) return; const [aid, type] = inp.dataset.docup.split("|");
    if (f.size > 10 * 1024 * 1024) return toast("Fichier trop lourd (10 Mo maximum).");
    toast("Envoi en cours…");
    try { await uploadDoc(aid, type, f); render(0); toast("Document envoyé"); } catch (e) { fail(e, "L'envoi n'a pas marché. Réessaie."); }
  }, "onchange");

  const form = (id, fn) => { const f = document.getElementById(id); if (f) f.onsubmit = async ev => { ev.preventDefault(); const b = f.querySelector("button:not([type=button])"); if (b) b.disabled = true; try { await fn(f); } catch (e) { fail(e); } finally { if (b && document.body.contains(b)) b.disabled = false; } }; };
  const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
  form("boardForm", async () => { const el = document.getElementById("boardForm"), id = el.dataset.id;
    const row = { title: val("bfTitle"), place: val("bfPlace"), description: val("bfDesc"), start_date: val("bfFrom"), end_date: val("bfTo"), day_start: val("bfStart"), day_end: val("bfEnd"),
      slot_minutes: +val("bfSlot"), capacity: Math.max(1, Math.min(50, +val("bfCap") || 1)), teams: [...$app.querySelectorAll("[name=bftm]:checked")].map(x => x.value) };
    if (row.end_date < row.start_date) return toast("La date de fin est avant la date de début.");
    if (dayDiff(row.start_date, row.end_date) > 92) return toast("3 mois maximum.");
    if (row.day_end <= row.day_start) return toast("La fin de journée doit être après le début.");
    try {
      if (id) { await q(sb.from("shift_boards").update(row).eq("id", id).select());
        const nb = { ...row, id }, ok = new Set(boardSlots(nb).map(x => x[0])), bad = D.shifts.filter(s => s.board_id === id && (s.day < row.start_date || s.day > row.end_date || !ok.has(hm(s.start_time))));
        for (const s of bad) await q(sb.from("shift_signups").delete().eq("board_id", id).eq("day", s.day).eq("start_time", s.start_time).eq("person_id", s.person_id).select()).catch(() => {});
        await loadAll(); go("planning", { kind: "board", id }); toast("Permanence modifiée"); }
      else { const [r] = await q(sb.from("shift_boards").insert({ ...row, created_by: me.id }).select()); await loadAll(); S.bday = null; go("planning", { kind: "board", id: r.id }); toast("Permanence créée : chacun peut maintenant réserver un créneau"); }
    } catch (e) { fail(e, "Ça n'a pas marché. La base est-elle à jour (mise à jour 17) ?"); } });

  const cq = document.getElementById("cq");
  if (cq) { cq.value = S.cq || ""; cq.oninput = () => { S.cq = cq.value; render(0); }; }
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

  const evd = document.getElementById("evDate");
  if (evd && document.getElementById("trDate")) evd.onchange = () => { document.getElementById("trDate").value = addDays(evd.value, -1); document.getElementById("trRDate").value = addDays(evd.value, 1); };
  const ty = document.getElementById("evType");
  if (ty) ty.onchange = () => { S.evType = ty.value; S.evTbd = false; S.skipRestore = true; render(0); };
  const ntc = document.getElementById("evNoTime"); if (ntc) ntc.onchange = () => { S.evTbd = ntc.checked; if (ntc.checked) { document.getElementById("evS").value = "14:00"; document.getElementById("evE").value = "17:00"; } };
  form("addev", async f => {
    const tms = [...f.querySelectorAll("[name=evtm]:checked")].map(x => x.value);
    if (!tms.length) return toast("Choisis au moins une équipe.");
    const type = val("evType"), base = { type, title: val("evTitle"), start_time: val("evS"), end_time: val("evE"), place: val("evPlace"), created_by: me.id };
    const ntb = document.getElementById("evNoTime"); if (ntb && ntb.checked) base.no_time = true;
    let dates = [val("evDate")];
    const rep = document.getElementById("evRepeat");
    if (type === "train" && rep && rep.checked) { const until = val("evUntil"); dates = []; for (let d = val("evDate"); d <= until && dates.length < 60; d = addDays(d, 7)) if (!inHolidays(d)) dates.push(d);
      if (!dates.length) return toast("Toutes ces dates tombent pendant les vacances."); }
    let step = "création de l'événement";
    try {
    const evs = await q(sb.from("events").insert(dates.map(date => ({ ...base, date }))).select());
    step = "choix des équipes";
    await q(sb.from("event_teams").insert(evs.flatMap(e => tms.map(team_id => ({ event_id: e.id, team_id })))).select());
    step = "création du déplacement";
    if (type === "comp") {
      const dDate = val("trDate") || evs[0].date, rDate = val("trRDate") >= dDate ? val("trRDate") : dDate, mode = val("trMode");
      const [tr] = await q(sb.from("trips").insert({ event_id: evs[0].id, transport: val("trTransport") || mode, depart_place: val("trPlace"), depart_date: dDate, depart_time: val("trTime") || null, return_date: rDate, return_time: val("trRet"), lodging: val("trLodging"), contact: val("trContact") }).select());
      await q(sb.from("trip_items").insert(DEFAULT_ITEMS.map((label, position) => ({ trip_id: tr.id, label, position }))).select());
      await q(sb.from("trip_legs").insert([
        { trip_id: tr.id, kind: "aller", mode, day: dDate, time: val("trTime") || null, from_place: val("trPlace"), to_place: val("evPlace"), details: "" },
        { trip_id: tr.id, kind: "retour", mode, day: rDate, from_place: val("evPlace"), to_place: val("trPlace"), details: val("trRet") ? "Arrivée prévue " + val("trRet") : "" }]).select());
      if (val("trTime")) await q(sb.from("trip_steps").insert({ trip_id: tr.id, day: dDate, time: val("trTime"), label: "Départ" }).select());
    }
    } catch (e) { return fail(e, `Ça n'a pas marché (étape : ${step}).`); }
    try { await loadAll(); } catch (e) { return fail(e, "L'événement est bien ajouté, mais le planning n'a pas pu se recharger."); }
    S.filter = "all"; S.tab = null; go("planning"); toast(dates.length > 1 ? `${dates.length} entraînements ajoutés` : "Ajouté au planning");
  });

  form("newsForm", async () => {
    const title = val("nwTitle"); if (!title) return toast("Donne un titre à l'actualité.");
    let image_path = null; const inp = document.getElementById("nwImg"); let f = inp && inp.files[0];
    if (f) { if (f.size > 10 * 1024 * 1024) return toast("Photo trop lourde (10 Mo maximum).");
      toast("Envoi de la photo…"); f = await shrink(f); image_path = `news/${Date.now()}-${safeName(f.name)}`;
      const { error } = await sb.storage.from(BUCKET).upload(image_path, f, { contentType: f.type || undefined }); if (error) throw error; }
    const [row] = await q(sb.from("news").insert({ title, body: val("nwBody"), image_path, pinned: document.getElementById("nwPin").checked, created_by: me.id }).select());
    D.news = [row].concat(D.news || []); S.newsOpen = false; S.skipRestore = true; render(0); toast("Actualité publiée");
  });
  form("editev", async f => {
    const id = S.view.id, tms = [...f.querySelectorAll("[name=eetm]:checked")].map(x => x.value);
    if (!tms.length) return toast("Choisis au moins une équipe.");
    const e = D.events.find(x => x.id === id), sc = f.querySelector("[name=eeScope]:checked");
    const list = sc && sc.value === "next" ? seriesOf(e) : [e], shift = dayDiff(e.date, val("eeDate"));
    const base = { title: val("eeTitle"), start_time: val("eeS"), end_time: val("eeE"), place: val("eePlace") };
    const nt = document.getElementById("eeNoTime"); if (nt) base.no_time = nt.checked;
    if (document.getElementById("eeType")) base.type = val("eeType");
    if (shift === 0) { for (const c of chunks(list.map(x => x.id))) await q(sb.from("events").update(base).in("id", c).select()); }
    else for (const c of chunks(list, 10)) await Promise.all(c.map(x => q(sb.from("events").update({ ...base, date: addDays(x.date, shift) }).eq("id", x.id).select())));
    if ([...tms].sort().join(",") !== [...e.teams].sort().join(",")) for (const c of chunks(list.map(x => x.id))) {
      await q(sb.from("event_teams").delete().in("event_id", c).select());
      await q(sb.from("event_teams").insert(c.flatMap(event_id => tms.map(team_id => ({ event_id, team_id })))).select());
    }
    await loadAll(); S.tab = null; go("planning"); toast(list.length > 1 ? `${list.length} entraînements modifiés` : "Événement modifié");
  });
  form("tripForm", async () => {
    const id = S.editTrip;
    const [row] = await q(sb.from("trips").update({ depart_date: val("tfDate") || null, return_date: val("tfRDate") || null, lodging: val("tfLodging"), depart_time: val("tfTime") || null, return_time: val("tfRet"), depart_place: val("tfPlace"), transport: val("tfTransport"), contact: val("tfContact") }).eq("id", id).select());
    D.trips = tripList().map(t => t.id === id ? row : t); S.editTrip = null; render(0); toast("Déplacement mis à jour");
  });
  form("addstep", async () => {
    const h = val("stH"), l = val("stL"); if (!h || !l) return toast("Indique l'heure et l'étape.");
    const tr = tripList().find(t => t.id === S.view.id), day = val("stD") || tr.depart_date || eventOf(tr).date; S.lastStepDay = day;
    const [row] = await q(sb.from("trip_steps").insert({ trip_id: S.view.id, day, time: h, label: l }).select()); D.steps.push(row);
    document.getElementById("stL").value = ""; render(0); toast("Étape ajoutée");
  });
  form("addleg", async () => {
    const row = { trip_id: S.view.id, kind: val("lgKind"), mode: val("lgMode"), day: val("lgDay") || null, time: val("lgTime") || null, from_place: val("lgFrom"), to_place: val("lgTo"), details: val("lgDetails") };
    if (val("lgADay")) row.arrive_day = val("lgADay");
    if (val("lgATime")) row.arrive_time = val("lgATime");
    const [res] = await q(sb.from("trip_legs").insert(row).select()); D.legs.push(res); S.skipRestore = true; render(0); toast("Trajet ajouté");
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
    const upd = { full_name: joinName("m"), role, team_id: ["athlete", "bureau", "coach"].includes(role) ? (val("mTeam") || null) : null, title: role === "bureau" ? val("mTitle") : null };
    if (document.getElementById("mBirth")) upd.birth_date = val("mBirth") || null;
    const mp = document.getElementById("mPlan"); if (mp) upd.can_plan = mp.checked; else if (role === "pending") upd.can_plan = false;
    if (role === "athlete" && !upd.team_id) return toast("Choisis l'équipe de l'athlète.");
    const [row] = await q(sb.from("profiles").update(upd).eq("id", id).select("*"));
    D.P[id] = row;
    const mg = $app.querySelector("[name=mGender]:checked"), pp = { gender: mg ? mg.value : null, image_consent: consentVal($app, "mConsent") };
    if (document.getElementById("mPhone")) pp.phone = val("mPhone");
    if (document.getElementById("mEmName")) { pp.emergency_name = val("mEmName"); pp.emergency_phone = val("mEmPhone"); }
    await savePriv(id, pp).catch(e => console.error(e));
    if (role === "parent") {
      const kids = [...f.querySelectorAll("[name=mkid]:checked")].map(x => x.value);
      const old = D.links.filter(l => l.parent_id === id), rows = kids.map(a => ({ parent_id: id, athlete_id: a, ...((old.find(l => l.athlete_id === a) || {}).legal ? { legal: true } : {}) }));
      await q(sb.from("parent_links").delete().eq("parent_id", id).select());
      if (rows.length) for (const r of rows) await q(sb.from("parent_links").insert(r).select());
      D.links = D.links.filter(l => l.parent_id !== id).concat(rows);
      // Les enfants déclarés à l'inscription sont validés avec leur parent
      const news = kids.filter(a => P(a).role === "pending");
      if (news.length) for (const r of await q(sb.from("profiles").update({ role: "athlete" }).in("id", news).select("*"))) D.P[r.id] = r;
    }
    if (role === "coach" || (D.coachTeams || []).some(c => c.coach_id === id)) {
      const ct = role === "coach" ? [...f.querySelectorAll("[name=mct]:checked")].map(x => x.value) : [];
      await q(sb.from("coach_teams").delete().eq("coach_id", id).select());
      if (ct.length) await q(sb.from("coach_teams").insert(ct.map(team_id => ({ coach_id: id, team_id }))).select());
      D.coachTeams = (D.coachTeams || []).filter(c => c.coach_id !== id).concat(ct.map(team_id => ({ coach_id: id, team_id })));
    }
    S.mRole = null; S.mKids = null; go("bureau"); toast("Fiche enregistrée");
  });

  form("nameForm", async () => {
    const upd = { full_name: joinName("acc") }; if (document.getElementById("accTeam")) upd.team_id = val("accTeam") || null;
    const [row] = await q(sb.from("profiles").update(upd).eq("id", me.id).select("*"));
    me = Object.assign(me, row); D.P[me.id] = me;
    const g = $app.querySelector("[name=accGender]:checked"), patch = { gender: g ? g.value : null, phone: val("accPhone"), image_consent: consentVal($app, "accConsent") };
    if (document.getElementById("accEmName")) { patch.emergency_name = val("accEmName"); patch.emergency_phone = val("accEmPhone"); }
    await savePriv(me.id, patch); render(0); toast("Informations enregistrées");
  });
  $app.querySelectorAll("[data-kidform]").forEach(f => f.onsubmit = async ev => { ev.preventDefault();
    const id = f.dataset.kidform, g = f.querySelector(`[name="kg-${id}"]:checked`), v = n => (f.querySelector(`[name=${n}]`) || {}).value;
    try { const patch = { gender: g ? g.value : null, emergency_name: v("kEmName").trim(), emergency_phone: v("kEmPhone").trim(), image_consent: consentVal(f, "kc-" + id) };
      if (f.querySelector("[name=kPhone]")) patch.phone = v("kPhone").trim();
      await savePriv(id, patch);
      const legal = f.querySelector("[name=kLegal]").checked;
      if (legal !== isLegal(me.id, id)) { await q(sb.rpc("set_legal_guardian", { a: id, v: legal })); const l = D.links.find(x => x.parent_id === me.id && x.athlete_id === id); if (l) l.legal = legal; }
      render(0); toast("Fiche enregistrée"); } catch (e) { fail(e); } });
  form("passForm", async () => {
    const { error } = await sb.auth.updateUser({ password: document.getElementById("accPass").value });
    if (error) return toast(frError(error)); document.getElementById("accPass").value = ""; toast("Mot de passe changé");
  });
  const lo = document.getElementById("logout"); if (lo) lo.onclick = async () => { await disablePush(); sb.auth.signOut(); };
  bindInstall();
}

/* Remet les données à jour quand on revient sur l'app */
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && D && me && me.role !== "pending") reload(); });

/* Service worker : rend l'app installable et utilisable hors ligne */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  navigator.serviceWorker.addEventListener("message", ev => { if (ev.data && ev.data.open) { location.hash = new URL(ev.data.open).hash; openFromHash(); } });
}
window.addEventListener("hashchange", openFromHash);

boot();
