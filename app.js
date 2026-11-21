import { firebaseConfig } from "./firebase-config.js";
import {
  initializeApp, getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, CACHE_SIZE_UNLIMITED,
  collection, doc, setDoc, deleteDoc, onSnapshot
} from "./vendor/firebase.js";

const LEVELS = ["初級", "中級", "上級", "エキスパート"];
const LVCLS = { "初級": "lv1", "中級": "lv2", "上級": "lv3", "エキスパート": "lv4" };
const app = document.getElementById("app");

/* ---------- Firebase ---------- */
const configured = firebaseConfig && firebaseConfig.apiKey && !/ここに/.test(firebaseConfig.apiKey);
let fb = null, db = null, auth = null, user = null;
let routes = [], images = {}, routesSig = "";
let status = { offline: !navigator.onLine, pending: false, fromCache: true };
let unsub = [];

if (configured) {
  fb = initializeApp(firebaseConfig);
  auth = getAuth(fb);
  db = initializeFirestore(fb, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager(), cacheSizeBytes: CACHE_SIZE_UNLIMITED })
  });
}

/* ---------- ui state ---------- */
let ui = { q: "", lv: "", sort: "mountain", done: "", cols: "auto", tab: "all" };
try { const s = JSON.parse(localStorage.getItem("yama-ui") || "null"); if (s) ui = Object.assign(ui, s); } catch (e) {}
function persistUi() { try { localStorage.setItem("yama-ui", JSON.stringify(ui)); } catch (e) {} }

/* ---------- helpers ---------- */
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function toast(msg, ms) { document.querySelectorAll(".toast").forEach(x => x.remove()); const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), ms || 2600); }
function safeUrl(u) { u = String(u || "").trim(); if (!u) return ""; if (!/^https?:\/\//i.test(u)) u = "https://" + u; return u; }
function climbsOf(r) { return (r.climbs || []).slice().sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0); }
function fmtDate(d) { if (!d) return ""; const p = d.split("-"); return p.length === 3 ? p[0] + "/" + (+p[1]) + "/" + (+p[2]) : d; }
function today() { const t = new Date(); t.setMinutes(t.getMinutes() - t.getTimezoneOffset()); return t.toISOString().slice(0, 10); }
function mountainTotal(name) { let n = 0; routes.forEach(r => { if ((r.mountain || "") === name) n += (r.climbs || []).length; }); return n; }
// 駐車場のGoogleマップ：URLが入っていればそれを、なければ駐車場名＋エリアで検索
function mapsUrl(r) {
  const u = String(r.parkingMap || "").trim();
  if (u) return safeUrl(u);
  if (!String(r.parking || "").trim()) return "";
  const q = [r.parking, (r.area || "").split(/[／\/]/)[0]].filter(Boolean).join(" ");
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
}
function find(id) { return routes.find(r => r.id === id) || null; }
let pendingImgs = {}; // images created in the open form, not yet written
function imgSrc(id) { return id ? (pendingImgs[id] || images[id] || "") : ""; }

const MTN = '<svg viewBox="0 0 400 160" preserveAspectRatio="none"><path d="M0 160 L0 110 L70 60 L120 95 L190 20 L260 90 L300 65 L400 120 L400 160Z" fill="#2f5d45" opacity=".55"/><path d="M0 160 L0 135 L90 95 L160 125 L240 80 L330 120 L400 105 L400 160Z" fill="#2f5d45" opacity=".85"/><path d="M190 20 L172 44 L182 40 L190 48 L199 38 L208 44Z" fill="#fff" opacity=".9"/></svg>';
const LOGO = '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#2f5d45"/><path d="M5 23 L13 12 L17 17 L20 13 L27 23Z" fill="#fff"/><path d="M13 12 L11 15 L13 14.5 L15 15.5Z" fill="#2f5d45"/></svg>';

/* ---------- data access ---------- */
function routesCol() { return collection(db, "users", user.uid, "routes"); }
function imagesCol() { return collection(db, "users", user.uid, "images"); }
// Writes are not awaited: offline they resolve only after reaching the server.
function fire(p) { p.catch(e => toast("保存エラー：" + (e.code || e.message || e), 5000)); }
function writeRoute(r) {
  const data = Object.assign({}, r); delete data.id;
  fire(setDoc(doc(routesCol(), r.id), data));
}
function writeImage(id, dataUrl) { fire(setDoc(doc(imagesCol(), id), { data: dataUrl, created: Date.now() })); }
function removeImage(id) { fire(deleteDoc(doc(imagesCol(), id))); }
function refsOf(r) { const s = new Set(); if (!r) return s; if (r.thumb) s.add(r.thumb); (r.maps || []).forEach(m => m.img && s.add(m.img)); return s; }
function cleanupImages(before, afterRoutes) {
  const used = new Set(); afterRoutes.forEach(r => refsOf(r).forEach(i => used.add(i)));
  before.forEach(i => { if (!used.has(i)) removeImage(i); });
}

/* ---------- images (compress to fit a Firestore document) ---------- */
function loadImg(blob) {
  return new Promise((res, rej) => { const url = URL.createObjectURL(blob); const im = new Image(); im.onload = () => { URL.revokeObjectURL(url); res(im); }; im.onerror = () => { URL.revokeObjectURL(url); rej(new Error("画像を読み込めませんでした")); }; im.src = url; });
}
async function compress(file, max, limitChars) {
  const im = await loadImg(file);
  let scale = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
  for (let round = 0; round < 6; round++) {
    const c = document.createElement("canvas"); c.width = Math.round(im.naturalWidth * scale); c.height = Math.round(im.naturalHeight * scale);
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
    for (const q of [0.85, 0.75, 0.65, 0.55, 0.45]) {
      const d = c.toDataURL("image/jpeg", q);
      if (d.length <= limitChars) return d;
    }
    scale *= 0.8;
  }
  throw new Error("画像が大きすぎます");
}
// thumbnails ~250KB, maps up to ~900KB (Firestore limit is 1MiB per document)
const THUMB = [1000, 250000], MAP = [2000, 900000];

/* ---------- routing ---------- */
function route() {
  if (!configured) return renderSetup();
  if (!user) return renderLogin();
  const h = location.hash.replace(/^#/, "");
  let mm = h.match(/^map-(.+)$/);
  if (mm) { const r = find(mm[1]); if (r) { if (!mapState || mapState.r.id !== r.id) renderMap(r); return; } }
  cleanupMap();
  if (h === "new") return renderForm(null);
  let m = h.match(/^edit-(.+)$/); if (m) return renderForm(find(m[1]));
  m = h.match(/^r-(.+)$/); if (m) { const r = find(m[1]); if (r) return renderDetail(r); }
  renderList();
}
function currentView() { const h = location.hash; return h === "#new" || /^#edit-/.test(h) ? "form" : /^#map-/.test(h) ? "map" : /^#r-/.test(h) ? "detail" : "list"; }
function go(h) { if (location.hash === "#" + h || (!h && !location.hash)) route(); else location.hash = h; window.scrollTo(0, 0); }
window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });

/* ---------- status pill ---------- */
function statusHtml() {
  if (status.offline) return '<span class="status off" id="st">圏外・オフライン' + (status.pending ? '（未送信あり）' : '') + '</span>';
  if (status.pending) return '<span class="status pend" id="st">送信中…</span>';
  return '<span class="status" id="st">同期済み</span>';
}
function updateStatus() { const el = document.getElementById("st"); if (el) el.outerHTML = statusHtml(); }
window.addEventListener("online", () => { status.offline = false; updateStatus(); });
window.addEventListener("offline", () => { status.offline = true; updateStatus(); });

/* ---------- setup / login ---------- */
function renderSetup() {
  app.innerHTML = '<div class="login"><h1>' + LOGO + '山ルート帳</h1><p>Firebaseの設定がまだです。<br><code>firebase-config.js</code> に、Firebaseコンソールでコピーした設定を貼り付けてください。</p></div>';
}
function renderLogin() {
  app.innerHTML = '<div class="login"><h1>' + LOGO + '山ルート帳</h1>' +
    '<div class="f"><label>メールアドレス</label><input id="em" type="email" autocomplete="username"></div>' +
    '<div class="f"><label>パスワード</label><input id="pw" type="password" autocomplete="current-password"></div>' +
    '<div class="err" id="err"></div><button class="btn primary" id="li">ログイン</button>' +
    '<p style="text-align:center;margin:14px 0 0"><a href="#" id="rs" style="font-size:13px">パスワードを忘れた</a></p></div>';
  const go_ = async () => {
    const e = document.getElementById("em").value.trim(), p = document.getElementById("pw").value, err = document.getElementById("err");
    err.textContent = "";
    try { await signInWithEmailAndPassword(auth, e, p); }
    catch (x) { err.textContent = /network/.test(x.code) ? "初回ログインには電波が必要です" : "メールアドレスかパスワードが違います"; }
  };
  document.getElementById("li").onclick = go_;
  document.getElementById("pw").onkeydown = ev => { if (ev.key === "Enter") go_(); };
  document.getElementById("rs").onclick = async ev => {
    ev.preventDefault(); const e = document.getElementById("em").value.trim();
    if (!e) { document.getElementById("err").textContent = "メールアドレスを入力してください"; return; }
    try { await sendPasswordResetEmail(auth, e); toast("再設定メールを送りました"); } catch (x) { toast("送信できませんでした"); }
  };
}

/* ---------- list ---------- */
function summaryHtml() {
  let total = 0, routesDone = 0; const mts = {};
  routes.forEach(r => { const c = (r.climbs || []).length; total += c; if (c) { routesDone++; mts[r.mountain || ""] = 1; } });
  if (!routes.length) return "";
  return '<div class="summary"><div class="s"><b>' + total + '</b>回 登頂</div><div class="s"><b>' + Object.keys(mts).length + '</b>山 登頂済み</div><div class="s"><b>' + routesDone + '</b>/' + routes.length + ' ルート踏破</div></div>';
}
/* ---------- 次に行く予定 ---------- */
const WD = ["日", "月", "火", "水", "木", "金", "土"];
function planned() {
  return routes.filter(r => r.plan).sort((a, b) => {
    const x = a.plan.date || "9999", y = b.plan.date || "9999";
    return x < y ? -1 : x > y ? 1 : (a.mountain || "").localeCompare(b.mountain || "", "ja");
  });
}
function daysUntil(d) { if (!d) return null; const t = new Date(today() + "T00:00:00"), x = new Date(d + "T00:00:00"); return Math.round((x - t) / 86400000); }
function planDateText(p) {
  if (!p || !p.date) return "日程未定";
  const x = new Date(p.date + "T00:00:00"); return (x.getMonth() + 1) + "/" + x.getDate() + "（" + WD[x.getDay()] + "）";
}
function planWhen(p) {
  const n = daysUntil(p && p.date);
  if (n === null) return "";
  if (n === 0) return '<span class="when today">今日！</span>';
  if (n === 1) return '<span class="when soon">明日</span>';
  if (n > 1) return '<span class="when">あと' + n + '日</span>';
  return '<span class="when past">予定日を過ぎています</span>';
}
function setPlan(r, plan) { const nr = JSON.parse(JSON.stringify(r)); nr.plan = plan; nr.updated = Date.now(); writeRoute(nr); }
function addClimb(r, date, memo, clearPlan) {
  const nr = JSON.parse(JSON.stringify(r));
  nr.climbs = (nr.climbs || []).concat([{ id: uid(), date, memo: memo || "" }]);
  // 予定日当日以降の登頂を記録したら、予定は自動で外す
  if (nr.plan && (clearPlan || !nr.plan.date || nr.plan.date <= date)) nr.plan = null;
  nr.updated = Date.now(); writeRoute(nr);
  toast(status.offline ? "記録しました（電波が戻ったら送信されます）" : "記録しました");
}
function planEditor(r, onDone) {
  const p = r.plan || {};
  const m = document.createElement("div"); m.className = "modal";
  m.innerHTML = '<div class="box"><h3 style="margin-top:0">📌 次に行く予定</h3><p class="muted" style="margin-top:-6px">' + esc(r.mountain || "") + '　' + esc(r.route || "") + '</p>' +
    '<div class="f"><label>行く日（未定なら空欄）</label><input type="date" id="pd" value="' + esc(p.date || "") + '"></div>' +
    '<div class="f"><label>メモ（任意）</label><input type="text" id="pm" value="' + esc(p.memo || "") + '" placeholder="例：7時 登山口集合／〇〇さんと"></div>' +
    '<div class="actions">' + (r.plan ? '<button class="btn danger" id="prm" style="margin-right:auto">予定を外す</button>' : '') + '<button class="btn" id="pcn">キャンセル</button><button class="btn primary" id="pok">決定</button></div></div>';
  document.body.appendChild(m);
  m.onclick = ev => { if (ev.target === m) m.remove(); };
  m.querySelector("#pcn").onclick = () => m.remove();
  m.querySelector("#pok").onclick = () => { setPlan(r, { date: m.querySelector("#pd").value || "", memo: m.querySelector("#pm").value.trim() }); m.remove(); toast("次に行く予定に入れました"); if (onDone) onDone(); };
  const rm = m.querySelector("#prm"); if (rm) rm.onclick = () => { setPlan(r, null); m.remove(); toast("予定を外しました"); };
}
function nextCard(r) {
  const p = r.plan, t = imgSrc(r.thumb), murl = mapsUrl(r), cl = climbsOf(r);
  const chips = [r.level ? lvBadge(r.level) : "", r.time ? '<span class="chip">⏱ ' + esc(r.time) + '</span>' : "", r.distance ? '<span class="chip">↔ ' + esc(r.distance) + ' km</span>' : "", r.elevation ? '<span class="chip">⬆ ' + esc(r.elevation) + '</span>' : "", cl.length ? '<span class="chip">登頂 ' + cl.length + '回</span>' : ""].join("");
  const maps = (r.maps || []).slice(0, 4);
  return '<article class="next" data-id="' + esc(r.id) + '">' +
    '<div class="nhead">' + (t ? '<img src="' + t + '" alt="">' : '<div class="nph">' + MTN + '</div>') +
    '<div class="ninfo"><div class="ndate">📌 ' + esc(planDateText(p)) + ' ' + planWhen(p) + '</div><div class="nmt">' + esc(r.mountain || "") + '</div><div class="nrt">' + esc(r.route || "") + '</div>' + (p.memo ? '<div class="nmemo">' + esc(p.memo) + '</div>' : '') + '</div></div>' +
    '<div class="chips" style="margin:10px 0">' + chips + '</div>' +
    (r.parking || murl ? '<div class="nrow"><span class="k">🅿️ 駐車場</span><span>' + (murl ? '<a href="' + esc(murl) + '" target="_blank" rel="noopener">' + esc(r.parking || "地図を見る") + ' 📍</a>' : esc(r.parking)) + (r.parkingFee ? '<span class="muted">（' + esc(r.parkingFee) + '）</span>' : '') + '</span></div>' : '') +
    (r.area ? '<div class="nrow"><span class="k">📍 エリア</span><span>' + esc(r.area) + '</span></div>' : '') +
    (r.caution ? '<div class="ncaution"><b>⚠️ 注意点</b><div class="pre">' + esc(r.caution) + '</div></div>' : '') +
    (maps.length ? '<div class="nmaps">' + maps.map(m => '<img src="' + imgSrc(m.img) + '" alt="" data-open="' + esc(r.id) + '">').join("") + '</div>' : '') +
    '<div class="nactions">' + (areaOnDevice(r.id) ? '' : (r.mapArea || r.gpx ? '<span class="warnchip chip">地図未保存</span>' : '')) + '<button class="btn small" data-act="map">🗺 地図</button><button class="btn small" data-act="detail">詳細を見る</button><button class="btn small" data-act="edit">予定を変更</button><button class="btn primary small" data-act="climb">✓ 登頂を記録</button></div></article>';
}
function nextHtml() {
  const ps = planned();
  if (!ps.length) return '<div class="empty">次に行く予定のルートはまだありません。<br>ルートの詳細ページで「📌 次に行く予定に入れる」を押すと、ここに表示されます。</div>';
  return '<div class="nextlist">' + ps.map(nextCard).join("") + '</div>';
}
function bindNext() {
  app.querySelectorAll(".next").forEach(el => {
    const r = find(el.dataset.id); if (!r) return;
    el.querySelector('[data-act="detail"]').onclick = () => go("r-" + r.id);
    el.querySelector('[data-act="map"]').onclick = () => go("map-" + r.id);
    el.querySelector('[data-act="edit"]').onclick = () => planEditor(r);
    el.querySelector('[data-act="climb"]').onclick = () => {
      const d = r.plan && r.plan.date && r.plan.date <= today() ? r.plan.date : today();
      confirmBox(fmtDate(d) + " に登頂したと記録しますか？（予定は外れます）", () => addClimb(r, d, "", true), "記録する", true);
    };
    const imgs = [...el.querySelectorAll(".nmaps img")];
    imgs.forEach((im, i) => { im.onclick = () => { lbList = imgs.map(x => x.src); openLb(i); }; });
  });
}
function gridCls() { return "grid" + (ui.cols === "auto" ? "" : " c" + ui.cols); }
function lvBadge(l) { return l ? '<span class="lv ' + (LVCLS[l] || "lv0") + '">' + esc(l) + '</span>' : ""; }
function shortTime(t) { t = String(t); return t.length > 22 ? t.slice(0, 22) + "…" : t; }
function card(r) {
  const chips = [];
  if (r.time) chips.push('<span class="chip">⏱ ' + esc(shortTime(r.time)) + '</span>');
  if (r.distance) chips.push('<span class="chip">↔ ' + esc(r.distance) + ' km</span>');
  const cl = climbsOf(r); if (cl.length) chips.push('<span class="chip">最終 ' + esc(fmtDate(cl[0].date)) + '</span>');
  const t = imgSrc(r.thumb);
  return '<button class="card" data-id="' + esc(r.id) + '"><div class="thumb">' + (t ? '<img loading="lazy" src="' + t + '" alt="">' : '<div class="ph">' + MTN + '</div>') +
    (r.level ? '<span class="badge-on">' + lvBadge(r.level) + '</span>' : '') + (r.plan ? '<span class="pin">📌 ' + esc(r.plan.date ? fmtDate(r.plan.date).slice(5) : "予定") + '</span>' : '') + (cl.length ? '<span class="done">✓<span class="dl"> 登頂</span> ' + cl.length + '<span class="dl">回</span></span>' : '') + '</div>' +
    '<div class="body"><div class="mt">' + esc(r.mountain || "（山名なし）") + '</div><div class="rt">' + esc(r.route || "") + (r.area ? '　<span class="muted">' + esc(r.area) + '</span>' : '') + '</div><div class="chips">' + chips.join("") + '</div></div></button>';
}
function renderList() {
  const q = ui.q.trim().toLowerCase();
  const list = routes.filter(r => {
    if (ui.lv && r.level !== ui.lv) return false;
    const c = (r.climbs || []).length; if (ui.done === "done" && !c) return false; if (ui.done === "not" && c) return false;
    if (!q) return true;
    return [r.mountain, r.route, r.area, r.parking, r.caution, r.memo].join(" ").toLowerCase().indexOf(q) >= 0;
  });
  list.sort((a, b) => {
    if (ui.sort === "updated") return (b.updated || 0) - (a.updated || 0);
    if (ui.sort === "climbs") return mountainTotal(b.mountain) - mountainTotal(a.mountain) || (b.climbs || []).length - (a.climbs || []).length || (a.mountain || "").localeCompare(b.mountain || "", "ja");
    if (ui.sort === "level") return LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || (a.mountain || "").localeCompare(b.mountain || "", "ja");
    return (a.mountain || "").localeCompare(b.mountain || "", "ja") || (a.route || "").localeCompare(b.route || "", "ja");
  });
  const sel = (k, v) => ui[k] === v ? " selected" : "";
  let html = '<header class="top"><h1>' + LOGO + '山ルート帳</h1>' + statusHtml() + '<div class="spacer"></div>' +
    '<button class="btn small" id="menu">⋯</button><button class="btn primary" id="add">＋ ルートを追加</button></header>' +
    '<div class="tabs"><button data-tab="next" class="' + (ui.tab === "next" ? "on" : "") + '">📌 次の山' + (planned().length ? ' <span class="tc">' + planned().length + '</span>' : '') + '</button><button data-tab="all" class="' + (ui.tab !== "next" ? "on" : "") + '">すべてのルート</button></div>';
  if (ui.tab === "next") {
    app.innerHTML = html + nextHtml();
    bindTop(); bindNext(); return;
  }
  html += '<div class="toolbar"><input id="q" type="search" placeholder="山名・ルート名・エリアで検索" value="' + esc(ui.q) + '">' +
    '<select id="lv"><option value="">難易度</option>' + LEVELS.map(l => '<option' + sel("lv", l) + '>' + l + '</option>').join("") + '</select>' +
    '<select id="sort"><option value="mountain"' + sel("sort", "mountain") + '>山の名前順</option><option value="level"' + sel("sort", "level") + '>難易度順</option><option value="climbs"' + sel("sort", "climbs") + '>登頂回数が多い順</option><option value="updated"' + sel("sort", "updated") + '>更新が新しい順</option></select>' +
    '<select id="done"><option value="">登頂状況</option><option value="done"' + sel("done", "done") + '>登頂済み</option><option value="not"' + sel("done", "not") + '>未登頂</option></select>' +
    '<div class="seg" role="group" aria-label="並べ方">' + [["auto", "自動"], ["1", "1列"], ["2", "2列"], ["3", "3列"]].map(c => '<button type="button" data-cols="' + c[0] + '" class="' + (ui.cols === c[0] ? "on" : "") + '">' + c[1] + '</button>').join("") + '</div></div>' +
    summaryHtml() + '<div class="count">' + list.length + ' 件</div>';
  if (!routes.length) html += '<div class="empty">まだルートがありません。<br>「＋ ルートを追加」から登録しましょう。</div>';
  else if (!list.length) html += '<div class="empty">条件に合うルートがありません。</div>';
  else if ((ui.sort === "mountain" || ui.sort === "climbs") && (ui.cols === "auto" || ui.cols === "1")) {
    const groups = {}, order = [];
    list.forEach(r => { const k = r.mountain || "（山名なし）"; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(r); });
    order.forEach(k => { const t = mountainTotal(k); html += '<div class="group-title">' + esc(k) + '　' + groups[k].length + 'ルート' + (t ? '<span class="gcount">⛰ 登頂 ' + t + '回</span>' : '') + '</div><div class="' + gridCls() + '">' + groups[k].map(card).join("") + '</div>'; });
  } else html += '<div class="' + gridCls() + '">' + list.map(card).join("") + '</div>';
  app.innerHTML = html;
  bindTop();
  const qi = document.getElementById("q");
  qi.addEventListener("input", () => { ui.q = qi.value; persistUi(); const pos = qi.selectionStart; renderList(); const n = document.getElementById("q"); n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} });
  document.getElementById("lv").onchange = e => { ui.lv = e.target.value; persistUi(); renderList(); };
  document.getElementById("sort").onchange = e => { ui.sort = e.target.value; persistUi(); renderList(); };
  document.getElementById("done").onchange = e => { ui.done = e.target.value; persistUi(); renderList(); };
  app.querySelectorAll("[data-cols]").forEach(b => { b.onclick = () => { ui.cols = b.dataset.cols; persistUi(); renderList(); }; });
  app.querySelectorAll(".card").forEach(c => { c.onclick = () => go("r-" + c.dataset.id); });
}
function bindTop() {
  document.getElementById("add").onclick = () => go("new");
  document.getElementById("menu").onclick = openMenu;
  app.querySelectorAll("[data-tab]").forEach(b => { b.onclick = () => { ui.tab = b.dataset.tab; persistUi(); renderList(); window.scrollTo(0, 0); }; });
}
function openMenu() {
  const m = document.createElement("div"); m.className = "modal";
  m.innerHTML = '<div class="box"><h3 style="margin-top:0">メニュー</h3><p class="muted" style="font-size:13px">ログイン中：' + esc(user.email || "") + '</p>' +
    '<div style="display:flex;flex-direction:column;gap:8px"><button class="btn" id="mexp">バックアップを書き出す（画像込み）</button><button class="btn" id="mimp">バックアップを読み込む</button><button class="btn" id="mupd">アプリを最新版にする</button><button class="btn danger" id="mout">ログアウト</button><button class="btn" id="mcl">閉じる</button></div>' +
    '<input type="file" id="mfile" accept=".json,application/json" hidden></div>';
  document.body.appendChild(m);
  m.onclick = ev => { if (ev.target === m) m.remove(); };
  m.querySelector("#mcl").onclick = () => m.remove();
  m.querySelector("#mexp").onclick = () => { exportData(); m.remove(); };
  const f = m.querySelector("#mfile");
  m.querySelector("#mimp").onclick = () => f.click();
  f.onchange = () => { if (f.files[0]) importData(f.files[0]); m.remove(); };
  m.querySelector("#mupd").onclick = () => { m.remove(); forceUpdate(); };
  m.querySelector("#mout").onclick = () => { m.remove(); confirmBox("ログアウトしますか？（オフラインでは再ログインできません）", () => signOut(auth), "ログアウト"); };
}

/* ---------- detail ---------- */
let lbList = [];
function renderDetail(r) {
  const urls = (r.urls || []).filter(u => u && u.url);
  const maps = r.maps || [];
  lbList = []; if (r.thumb) lbList.push(imgSrc(r.thumb)); maps.forEach(m => lbList.push(imgSrc(m.img)));
  const stat = (k, v, unit) => '<div class="stat"><div class="k">' + k + '</div><div class="v">' + (v ? esc(v) + (unit || "") : '<span class="muted">—</span>') + '</div></div>';
  const t = imgSrc(r.thumb);
  const parkingStat = r => {
    const url = mapsUrl(r);
    if (!url) return stat("駐車場", r.parking);
    return '<a class="stat maplink" href="' + esc(url) + '" target="_blank" rel="noopener"><div class="k">駐車場　<span class="mapgo">📍 地図で開く</span></div><div class="v">' + (r.parking ? esc(r.parking) : '地図を見る') + '</div></a>';
  };
  let html = '<div class="back" style="display:flex;gap:8px;align-items:center"><button class="btn small" id="back">← 一覧へ</button>' + statusHtml() + '</div>' +
    '<div class="hero">' + (t ? '<img id="heroimg" src="' + t + '" alt="">' : '<div class="ph">' + MTN + '</div>') + '</div>' +
    '<div class="dhead"><div><h2>' + esc(r.mountain || "（山名なし）") + '</h2><div class="rt">' + esc(r.route || "") + '</div></div><div class="spacer"></div>' + lvBadge(r.level) +
    '<button class="btn small" id="edit">✎ 編集</button></div>' +
    (r.area ? '<div class="muted">📍 ' + esc(r.area) + '</div>' : '') +
    (r.plan ? '<div class="planbox"><div>📌 次に行く予定：<b>' + esc(planDateText(r.plan)) + '</b> ' + planWhen(r.plan) + (r.plan.memo ? '<div class="muted">' + esc(r.plan.memo) + '</div>' : '') + '</div><button class="btn small" id="plan">変更</button></div>'
      : '<button class="btn small" id="plan" style="margin-top:10px">📌 次に行く予定に入れる</button>') +
    '<div class="stats">' + stat("難易度", r.level) + stat("所要時間", r.time) + stat("距離", r.distance, " km") + (r.elevation ? stat("標高差・累積標高", r.elevation) : "") + parkingStat(r) + stat("駐車料金", r.parkingFee) + '</div>';
  const cl = climbsOf(r), mt = mountainTotal(r.mountain || "");
  html += '<div class="sec"><h3>⛰ 登頂記録<span class="bigcount">このルート <b>' + cl.length + '</b>回' + (mt !== cl.length ? '　／　' + esc(r.mountain) + ' 合計 <b>' + mt + '</b>回' : '') + '</span></h3>' +
    (cl.length ? '<ul class="climbs">' + cl.map((c, i) => '<li><span class="n">' + (cl.length - i) + '回目</span><span class="d">' + esc(fmtDate(c.date)) + '</span><span class="m">' + esc(c.memo || "") + '</span><button class="x" data-cid="' + esc(c.id) + '" aria-label="削除">×</button></li>').join("") + '</ul>' : '<div class="muted">まだ登頂記録がありません</div>') +
    '<div class="addclimb"><input type="date" id="cdate" value="' + today() + '"><input type="text" id="cmemo" placeholder="ひとこと（天気・一緒に行った人など）"><button class="btn primary small" id="cadd">＋ 登頂を記録</button></div></div>';
  if (r.caution) html += '<div class="sec warn"><h3>⚠️ 注意点</h3><div class="pre">' + esc(r.caution) + '</div></div>';
  html += '<div class="sec"><h3>🧭 オフライン地図</h3><div class="chips" style="margin-bottom:8px">' + mapBadge(r) + (r.gpx ? '<span class="chip">GPXルートあり</span>' : '') + '</div><button class="btn primary small" id="omap">🗺 地図を開く</button> <span class="muted" style="font-size:12px">国土地理院の地図を保存して、圏外でも現在地を確認できます</span></div>';
  html += '<div class="sec"><h3>🗺 地図・写真</h3>' + (maps.length ? '<div class="gallery">' + maps.map((m, i) => '<figure><img loading="lazy" data-i="' + (i + (r.thumb ? 1 : 0)) + '" src="' + imgSrc(m.img) + '" alt="">' + (m.caption ? '<figcaption>' + esc(m.caption) + '</figcaption>' : '') + '</figure>').join("") + '</div>' : '<div class="muted">まだ画像がありません</div>') + '</div>';
  html += '<div class="sec"><h3>🔗 参考リンク</h3>' + (urls.length ? '<ul class="links">' + urls.map(u => { const href = safeUrl(u.url); const yt = /youtu\.?be/i.test(href); return '<li><a href="' + esc(href) + '" target="_blank" rel="noopener">' + (yt ? "▶️" : "🌐") + ' <span class="lbl">' + esc(u.label || href) + '</span></a>' + (u.label ? ' <span class="u">' + esc(href) + '</span>' : '') + '</li>'; }).join("") + '</ul>' : '<div class="muted">リンクなし</div>') + '</div>';
  html += '<div class="sec"><h3>📝 備考</h3>' + (r.memo ? '<div class="pre">' + esc(r.memo) + '</div>' : '<div class="muted">—</div>') + '</div>';
  html += '<div class="muted" style="font-size:12px;text-align:right">最終更新：' + (r.updated ? new Date(r.updated).toLocaleDateString("ja-JP") : "—") + '</div>';
  app.innerHTML = html;
  document.getElementById("back").onclick = () => go("");
  document.getElementById("edit").onclick = () => go("edit-" + r.id);
  document.getElementById("plan").onclick = () => planEditor(r);
  document.getElementById("omap").onclick = () => go("map-" + r.id);
  document.getElementById("cadd").onclick = () => {
    const d = document.getElementById("cdate").value; if (!d) { toast("日付を選んでください"); return; }
    addClimb(r, d, document.getElementById("cmemo").value.trim());
  };
  app.querySelectorAll(".climbs .x").forEach(b => { b.onclick = () => {
    const c = (r.climbs || []).find(x => x.id === b.dataset.cid); if (!c) return;
    confirmBox(fmtDate(c.date) + " の登頂記録を削除しますか？", () => { const nr = JSON.parse(JSON.stringify(r)); nr.climbs = nr.climbs.filter(x => x.id !== c.id); writeRoute(nr); });
  }; });
  const hi = document.getElementById("heroimg"); if (hi) hi.onclick = () => openLb(0);
  app.querySelectorAll(".gallery img").forEach(im => { im.onclick = () => openLb(+im.dataset.i); });
}
function openLb(i) {
  let idx = i; const d = document.createElement("div"); d.className = "lb";
  d.innerHTML = '<img alt=""><button class="x" aria-label="閉じる">×</button>' + (lbList.length > 1 ? '<button class="nav prev">‹</button><button class="nav next">›</button>' : '');
  const im = d.querySelector("img"); const show = () => { im.src = lbList[idx]; }; show();
  const p = d.querySelector(".prev"), n = d.querySelector(".next");
  const close = () => { d.remove(); document.removeEventListener("keydown", key); };
  function key(ev) { if (ev.key === "Escape") close(); if (ev.key === "ArrowLeft" && p) p.click(); if (ev.key === "ArrowRight" && n) n.click(); }
  d.onclick = ev => { if (ev.target === d || ev.target.classList.contains("x")) close(); };
  if (p) p.onclick = ev => { ev.stopPropagation(); idx = (idx - 1 + lbList.length) % lbList.length; show(); };
  if (n) n.onclick = ev => { ev.stopPropagation(); idx = (idx + 1) % lbList.length; show(); };
  document.addEventListener("keydown", key); document.body.appendChild(d);
}

/* ---------- form ---------- */
function renderForm(orig) {
  pendingImgs = {};
  const r = orig ? JSON.parse(JSON.stringify(orig)) : { id: uid(), mountain: "", route: "", area: "", level: "", time: "", distance: "", elevation: "", parking: "", parkingMap: "", parkingFee: "", urls: [], caution: "", memo: "", thumb: null, maps: [], climbs: [] };
  if (!r.urls || !r.urls.length) r.urls = [{ label: "", url: "" }];
  if (!r.maps) r.maps = [];
  const mountains = [...new Set(routes.map(x => x.mountain).filter(Boolean))];
  const inp = (k, label, ph, type) => '<div class="f"><label>' + label + '</label><input data-k="' + k + '" ' + (type ? 'type="' + type + '" step="0.1" inputmode="decimal"' : '') + ' value="' + esc(r[k]) + '" placeholder="' + esc(ph || "") + '"' + (k === "mountain" ? ' list="mlist"' : '') + '></div>';
  const ta = (k, label, ph) => '<div class="f"><label>' + label + '</label><textarea data-k="' + k + '" placeholder="' + esc(ph || "") + '">' + esc(r[k]) + '</textarea></div>';
  app.innerHTML = '<div class="back"><button class="btn small" id="cancel0">← 戻る</button></div>' +
    '<div class="form"><h2>' + (orig ? "ルートを編集" : "ルートを追加") + '</h2>' +
    '<datalist id="mlist">' + mountains.map(m => '<option value="' + esc(m) + '">').join("") + '</datalist>' +
    '<div class="row">' + inp("mountain", "山の名前 *", "例：金剛山") + inp("route", "ルート名", "例：千早本道") + '</div>' +
    '<div class="row">' + inp("area", "エリア・登山口", "例：大阪府 千早赤阪村／まつまさ前") +
    '<div class="f"><label>難易度</label><select data-k="level"><option value="">—</option>' + LEVELS.map(l => '<option' + (r.level === l ? " selected" : "") + '>' + l + '</option>').join("") + '</select></div></div>' +
    '<div class="row">' + inp("time", "所要時間", "例：上り 1:30 / 下り 1:00") + inp("distance", "距離（km）", "例：5.6", "number") + inp("elevation", "標高差・累積標高（任意）", "例：+600m") + '</div>' +
    '<div class="row">' + inp("parking", "駐車場", "例：登山口近くの有料駐車場") + inp("parkingFee", "駐車料金", "例：1日 600円") + '</div>' +
    '<div class="f"><label>駐車場のGoogleマップURL（任意）</label><input data-k="parkingMap" type="url" value="' + esc(r.parkingMap) + '" placeholder="Googleマップの「共有」でコピーしたURL（例：https://maps.app.goo.gl/...）"><div class="muted" style="font-size:12px">空欄なら、駐車場名とエリアでGoogleマップを検索して開きます。場所をピッタリ指定したいときに貼ってください。</div></div>' +
    '<div class="f"><label>サムネイル画像</label><div class="thumbedit" id="thumbbox"></div></div>' +
    '<div class="f"><label>地図・写真（複数可）</label><div class="imgs" id="mapbox"></div><div class="drop" id="mapdrop" style="margin-top:8px">ここをタップ／画像をドロップして追加（スクショもOK）</div><input type="file" id="mapfile" accept="image/*" multiple hidden></div>' +
    '<div class="f"><label>参考URL（サイト・YouTubeなど）</label><div id="urlbox"></div><button class="btn small" id="addurl" type="button" style="align-self:flex-start">＋ URLを追加</button></div>' +
    ta("caution", "注意点", "例：分岐で道迷い注意。冬季は凍結、軽アイゼン必携。") + ta("memo", "備考", "例：山頂の売店でおでん。") +
    '<div class="actions">' + (orig ? '<button class="btn danger" id="del" type="button" style="margin-right:auto">削除</button>' : '') + '<button class="btn" id="cancel" type="button">キャンセル</button><button class="btn primary" id="save" type="button">保存</button></div></div>';

  app.querySelectorAll("[data-k]").forEach(el => { const f = () => { r[el.dataset.k] = el.value; }; el.addEventListener("input", f); el.addEventListener("change", f); });
  let busy = 0;
  const setBusy = d => { busy += d; const s = document.getElementById("save"); if (!s) return; s.disabled = busy > 0; s.textContent = busy > 0 ? "画像を処理中…" : "保存"; };

  function drawThumb() {
    const b = document.getElementById("thumbbox");
    b.innerHTML = (r.thumb ? '<img src="' + imgSrc(r.thumb) + '" alt="">' : '') + '<div style="display:flex;flex-direction:column;gap:6px"><button class="btn small" id="tpick" type="button">' + (r.thumb ? "画像を変更" : "画像を選ぶ") + '</button>' + (r.thumb ? '<button class="btn small danger" id="trm" type="button">外す</button>' : '') + (r.maps.length ? '<button class="btn small" id="tfrom" type="button">地図・写真の1枚目を使う</button>' : '') + '</div><input type="file" id="tfile" accept="image/*" hidden>';
    const tf = document.getElementById("tfile");
    document.getElementById("tpick").onclick = () => tf.click();
    tf.onchange = async () => { const f = tf.files[0]; if (!f) return; setBusy(1);
      try { const id = uid(); pendingImgs[id] = await compress(f, THUMB[0], THUMB[1]); r.thumb = id; drawThumb(); } catch (e) { toast("画像を追加できませんでした：" + (e.message || e), 4000); }
      setBusy(-1); };
    const rm = document.getElementById("trm"); if (rm) rm.onclick = () => { r.thumb = null; drawThumb(); };
    const fr = document.getElementById("tfrom"); if (fr) fr.onclick = () => { r.thumb = r.maps[0].img; drawThumb(); };
  }
  function drawMaps() {
    const b = document.getElementById("mapbox");
    b.innerHTML = r.maps.map((m, i) => '<div class="imgbox"><img src="' + imgSrc(m.img) + '" alt=""><button class="rm" data-i="' + i + '" type="button" aria-label="削除">×</button><input data-c="' + i + '" placeholder="説明（任意）" value="' + esc(m.caption || "") + '"></div>').join("");
    b.querySelectorAll(".rm").forEach(x => { x.onclick = () => { r.maps.splice(+x.dataset.i, 1); drawMaps(); drawThumb(); }; });
    b.querySelectorAll("input[data-c]").forEach(x => { x.oninput = () => { r.maps[+x.dataset.c].caption = x.value; }; });
  }
  function addMapFiles(files) {
    Array.from(files).forEach(async f => {
      if (!/^image\//.test(f.type)) return;
      setBusy(1);
      try { const id = uid(); pendingImgs[id] = await compress(f, MAP[0], MAP[1]); r.maps.push({ img: id, caption: "" }); drawMaps(); drawThumb(); }
      catch (e) { toast("画像を追加できませんでした：" + (e.message || e), 4000); }
      setBusy(-1);
    });
  }
  const drop = document.getElementById("mapdrop"), mf = document.getElementById("mapfile");
  drop.onclick = () => mf.click(); mf.onchange = () => { addMapFiles(mf.files); mf.value = ""; };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("on"); }; drop.ondragleave = () => drop.classList.remove("on");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("on"); addMapFiles(e.dataTransfer.files); };
  const onPaste = e => { if (!document.getElementById("mapdrop")) { document.removeEventListener("paste", onPaste); return; } const fs = (e.clipboardData || {}).files; if (fs && fs.length) addMapFiles(fs); };
  document.addEventListener("paste", onPaste);

  function drawUrls() {
    const b = document.getElementById("urlbox");
    b.innerHTML = r.urls.map((u, i) => '<div class="urlrow"><input data-ul="' + i + '" placeholder="表示名（例：YAMAP活動日記）" value="' + esc(u.label) + '"><input data-uu="' + i + '" type="url" placeholder="https://..." value="' + esc(u.url) + '"><button class="btn small" data-ur="' + i + '" type="button" aria-label="削除">×</button></div>').join("");
    b.querySelectorAll("[data-ul]").forEach(x => { x.oninput = () => { r.urls[+x.dataset.ul].label = x.value; }; });
    b.querySelectorAll("[data-uu]").forEach(x => { x.oninput = () => { r.urls[+x.dataset.uu].url = x.value; }; });
    b.querySelectorAll("[data-ur]").forEach(x => { x.onclick = () => { r.urls.splice(+x.dataset.ur, 1); if (!r.urls.length) r.urls.push({ label: "", url: "" }); drawUrls(); }; });
  }
  document.getElementById("addurl").onclick = () => { r.urls.push({ label: "", url: "" }); drawUrls(); };
  drawThumb(); drawMaps(); drawUrls();

  const leave = () => { pendingImgs = {}; go(orig ? "r-" + orig.id : ""); };
  document.getElementById("cancel").onclick = leave; document.getElementById("cancel0").onclick = leave;
  document.getElementById("save").onclick = () => {
    if (!String(r.mountain).trim()) { toast("山の名前を入力してください"); document.querySelector('[data-k="mountain"]').focus(); return; }
    r.urls = r.urls.filter(u => u.url && u.url.trim()).map(u => ({ label: (u.label || "").trim(), url: safeUrl(u.url) }));
    r.updated = Date.now();
    const used = refsOf(r);
    Object.keys(pendingImgs).forEach(id => { if (used.has(id)) { images[id] = pendingImgs[id]; writeImage(id, pendingImgs[id]); } });
    pendingImgs = {};
    writeRoute(r);
    if (orig) cleanupImages(refsOf(orig), routes.filter(x => x.id !== r.id).concat([r]));
    toast(status.offline ? "保存しました（電波が戻ったら送信されます）" : "保存しました");
    try { history.replaceState(null, "", "#r-" + r.id); } catch (e) {}
    route();
  };
  const del = document.getElementById("del");
  if (del) del.onclick = () => confirmBox("「" + (orig.mountain || "") + " " + (orig.route || "") + "」を削除しますか？", () => {
    fire(deleteDoc(doc(routesCol(), orig.id)));
    cleanupImages(refsOf(orig), routes.filter(x => x.id !== orig.id));
    try { history.replaceState(null, "", "#"); } catch (e) {}
    go("");
  });
}
function confirmBox(msg, ok, label, normal) {
  const m = document.createElement("div"); m.className = "modal";
  m.innerHTML = '<div class="box"><p style="margin-top:0">' + esc(msg) + '</p><div class="actions"><button class="btn" id="cn">キャンセル</button><button class="btn primary" id="ok"' + (normal ? '' : ' style="background:#a33b3b;border-color:#a33b3b"') + '>' + esc(label || "削除する") + '</button></div></div>';
  document.body.appendChild(m); m.querySelector("#cn").onclick = () => m.remove(); m.querySelector("#ok").onclick = () => { m.remove(); ok(); };
}

/* ---------- 最新版に更新 ---------- */
// アプリ本体のキャッシュだけを消して読み直す（登山データは消えない）
async function forceUpdate() {
  if (!navigator.onLine) { toast("電波のある場所で行ってください"); return; }
  toast("最新版を読み込んでいます…", 5000);
  try {
    if ("caches" in window) { const ks = await caches.keys(); await Promise.all(ks.filter(k => k !== "yama-tiles").map(k => caches.delete(k))); } // 保存した地図は消さない
    if (navigator.serviceWorker) { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r => r.unregister())); }
  } catch (e) {}
  // ブラウザ側のキャッシュも新しいファイルで上書きしておく
  try { await Promise.all(["./", "./index.html", "./app.js", "./style.css", "./sw.js", "./firebase-config.js", "./vendor/firebase.js", "./vendor/leaflet/leaflet.js", "./vendor/leaflet/leaflet.css"].map(f => fetch(f, { cache: "reload" }))); } catch (e) {}
  location.replace(location.pathname + "?v=" + Date.now() + location.hash);
}

/* ---------- backup ---------- */
function exportData() {
  const used = new Set(); routes.forEach(r => refsOf(r).forEach(i => used.add(i)));
  const imgs = {}; used.forEach(i => { if (images[i]) imgs[i] = images[i]; });
  const blob = new Blob([JSON.stringify({ app: "yama-route-book", version: 2, exported: new Date().toISOString(), routes, images: imgs })], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "山ルート帳_バックアップ_" + today() + ".json";
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function importData(file) {
  let d; try { d = JSON.parse(await file.text()); } catch (e) { toast("ファイルを読み込めませんでした"); return; }
  if (!d || !Array.isArray(d.routes)) { toast("形式が正しくありません"); return; }
  let skipped = 0, n = 0;
  for (const src of d.routes) {
    const r = Object.assign({}, src); r.id = r.id || uid();
    // v1 (claude.ai artifact) format: thumb/maps are objects with data or id
    const conv = im => { if (!im) return null; if (typeof im === "string") { if (d.images && d.images[im]) { writeImage(im, d.images[im]); images[im] = d.images[im]; return im; } return null; }
      if (im.data) { const id = uid(); writeImage(id, im.data); images[id] = im.data; return id; } skipped++; return null; };
    r.thumb = conv(r.thumb);
    r.maps = (r.maps || []).map(m => { const img = conv(m.img !== undefined ? m.img : m); return img ? { img, caption: m.caption || "" } : null; }).filter(Boolean);
    r.climbs = r.climbs || []; r.urls = r.urls || [];
    delete r._t;
    writeRoute(r); n++;
  }
  toast(n + "件 読み込みました" + (skipped ? "（画像" + skipped + "枚は引き継げなかったので、追加し直してください）" : ""), 6000);
}

/* ---------- boot ---------- */
function startListeners() {
  unsub.forEach(f => f()); unsub = [];
  unsub.push(onSnapshot(routesCol(), { includeMetadataChanges: true }, snap => {
    status.pending = snap.metadata.hasPendingWrites; status.fromCache = snap.metadata.fromCache;
    const next = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    const sig = JSON.stringify(next);
    if (sig !== routesSig) { routesSig = sig; routes = next; const v = currentView(); if (v === "map") { if (mapState) { mapState.r = find(mapState.r.id) || mapState.r; } else route(); } else if (v !== "form") route(); }
    else updateStatus();
  }, e => toast("読み込みエラー：" + (e.code || e.message), 5000)));
  unsub.push(onSnapshot(imagesCol(), snap => {
    let changed = false;
    snap.docChanges().forEach(c => { if (c.type === "removed") delete images[c.doc.id]; else images[c.doc.id] = c.doc.data().data; changed = true; });
    if (changed && currentView() !== "form" && currentView() !== "map") route();
  }));
}
if (configured) {
  app.innerHTML = '<div class="empty">読み込み中…</div>';
  onAuthStateChanged(auth, u => {
    user = u; routes = []; images = {}; routesSig = "";
    if (u) startListeners(); else { unsub.forEach(f => f()); unsub = []; }
    route();
  });
} else route();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then(reg => {
    // アプリに戻ってきたときにも更新を確認する（スマホはアプリを閉じないことが多いため）
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  }).catch(() => {});
}

/* =====================================================================
   オフライン地図（地理院タイル）
   - 表示している範囲を、ズーム10〜16で端末(Cache Storage)に保存
   - 圏外でも sw.js が保存済みタイルを返す
   - GPSの現在地、GPXのルート線を表示
   ===================================================================== */
const TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png";
const TILE_CACHE = "yama-tiles";
const Z_MIN = 10, Z_MAX = 16, TILE_LIMIT = 4000, KB_PER_TILE = 18;
let mapState = null;

function tileUrl(z, x, y) { return TILE_URL.replace("{z}", z).replace("{x}", x).replace("{y}", y); }
function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function lat2y(lat, z) { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z)); }
function tilesIn(a) { // a = {s,w,n,e}
  const out = [];
  for (let z = Z_MIN; z <= Z_MAX; z++) {
    const x0 = lon2x(a.w, z), x1 = lon2x(a.e, z), y0 = lat2y(a.n, z), y1 = lat2y(a.s, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(tileUrl(z, x, y));
  }
  return out;
}
function countTiles(a) {
  let n = 0;
  for (let z = Z_MIN; z <= Z_MAX; z++) n += (lon2x(a.e, z) - lon2x(a.w, z) + 1) * (lat2y(a.s, z) - lat2y(a.n, z) + 1);
  return n;
}
function localAreas() { try { return JSON.parse(localStorage.getItem("yama-map-areas") || "{}"); } catch (e) { return {}; } }
function saveLocalAreas(o) { try { localStorage.setItem("yama-map-areas", JSON.stringify(o)); } catch (e) {} }
function areaOnDevice(id) { return localAreas()[id] || null; }
function mapBadge(r) {
  const a = areaOnDevice(r.id);
  return a ? '<span class="chip">✓ 地図保存済み（' + new Date(a.date).toLocaleDateString("ja-JP") + '）</span>' : (r.mapArea ? '<span class="chip warnchip">地図：この端末には未保存</span>' : '');
}
function boundsToArea(b) { return { s: +b.getSouth().toFixed(5), w: +b.getWest().toFixed(5), n: +b.getNorth().toFixed(5), e: +b.getEast().toFixed(5) }; }

function cleanupMap() {
  if (!mapState) return;
  mapState.cancel = true;
  if (mapState.watch != null) navigator.geolocation.clearWatch(mapState.watch);
  try { mapState.map.remove(); } catch (e) {}
  document.body.classList.remove("mapmode");
  mapState = null;
}

function renderMap(r) {
  cleanupMap();
  if (!window.L) { toast("地図の部品を読み込めませんでした"); go("r-" + r.id); return; }
  document.body.classList.add("mapmode");
  app.innerHTML = '<div class="mapwrap">' +
    '<div class="maptop"><button class="btn small" id="mback">←</button><div class="mtitle"><b>' + esc(r.mountain || "") + '</b> <span class="muted">' + esc(r.route || "") + '</span></div>' +
    '<form id="msearch" class="msearch"><input id="mq" type="search" placeholder="地名・山名で移動" value=""><button class="btn small">🔍</button></form></div>' +
    '<div id="map"></div>' +
    '<div class="mapbar">' +
    '<button class="btn" id="mloc">📍 現在地</button>' +
    '<button class="btn primary" id="mdl">📥 この範囲を保存</button>' +
    '<button class="btn" id="mmore">⋯</button>' +
    '</div><div class="minfo" id="minfo"></div>' +
    '<input type="file" id="mgpx" accept=".gpx,application/gpx+xml,application/xml,text/xml" hidden></div>';

  const map = L.map("map", { zoomControl: true, attributionControl: true, minZoom: 5, maxZoom: 18 });
  mapState = { map, r, watch: null, follow: false, cancel: false };
  L.tileLayer(TILE_URL, {
    minZoom: 5, maxZoom: 18, maxNativeZoom: Z_MAX,
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>'
  }).addTo(map);
  map.attributionControl.setPrefix(false);

  // GPXのルート線
  let fitted = false;
  if (r.gpx && r.gpx.pts && r.gpx.pts.length) {
    const line = L.polyline(r.gpx.pts, { color: "#c8642c", weight: 5, opacity: .85 }).addTo(map);
    L.circleMarker(r.gpx.pts[0], { radius: 7, color: "#fff", weight: 2, fillColor: "#2f5d45", fillOpacity: 1 }).addTo(map).bindTooltip("スタート");
    L.circleMarker(r.gpx.pts[r.gpx.pts.length - 1], { radius: 7, color: "#fff", weight: 2, fillColor: "#a33b3b", fillOpacity: 1 }).addTo(map).bindTooltip("ゴール");
    map.fitBounds(line.getBounds(), { padding: [30, 30] }); fitted = true;
  }
  (r.gpx && r.gpx.wpts || []).forEach(w => L.circleMarker([w.lat, w.lng], { radius: 5, color: "#fff", weight: 2, fillColor: "#d19a1f", fillOpacity: 1 }).addTo(map).bindTooltip(esc(w.name || ""), { permanent: !!w.name, direction: "top", className: "wptip" }));

  // 保存済み範囲の枠
  const area = areaOnDevice(r.id) || r.mapArea;
  if (area) {
    const rect = L.rectangle([[area.s, area.w], [area.n, area.e]], { color: "#2f5d45", weight: 2, dashArray: "6 6", fill: false, interactive: false }).addTo(map);
    mapState.rect = rect;
    if (!fitted) { map.fitBounds(rect.getBounds()); fitted = true; }
  }
  if (!fitted) {
    map.setView([35.4, 136.5], 6);
    if (navigator.onLine && r.mountain) searchPlace(r.mountain, true);
  }

  updateMapInfo();
  document.getElementById("mback").onclick = () => go("r-" + r.id);
  document.getElementById("msearch").onsubmit = ev => { ev.preventDefault(); const q = document.getElementById("mq").value.trim(); if (q) searchPlace(q); };
  document.getElementById("mloc").onclick = toggleLocation;
  document.getElementById("mdl").onclick = () => startDownload(boundsToArea(map.getBounds()));
  document.getElementById("mmore").onclick = mapMenu;
  const gf = document.getElementById("mgpx");
  gf.onchange = async () => { const f = gf.files[0]; gf.value = ""; if (f) importGpx(r, f); };
}

async function searchPlace(q, quiet) {
  if (!navigator.onLine) { if (!quiet) toast("地名検索には電波が必要です"); return; }
  try {
    const res = await fetch("https://msearch.gsi.go.jp/address-search/AddressSearch?q=" + encodeURIComponent(q));
    const list = await res.json();
    if (!mapState) return;
    if (!list || !list.length) { if (!quiet) toast("見つかりませんでした"); return; }
    const c = list[0].geometry.coordinates;
    mapState.map.setView([c[1], c[0]], 14);
    if (quiet) toast("「" + q + "」付近を表示しています。範囲を調整して保存してください", 4500);
  } catch (e) { if (!quiet) toast("検索できませんでした"); }
}

function toggleLocation() {
  const st = mapState; if (!st) return;
  if (!navigator.geolocation) { toast("この端末では現在地を使えません"); return; }
  if (st.watch != null) { // 2回目以降は現在地へ移動
    if (st.me) st.map.setView(st.me.getLatLng(), Math.max(st.map.getZoom(), 15));
    return;
  }
  toast("現在地を取得しています…");
  let first = true;
  st.watch = navigator.geolocation.watchPosition(p => {
    if (!mapState) return;
    const ll = [p.coords.latitude, p.coords.longitude];
    if (!st.me) {
      st.acc = L.circle(ll, { radius: p.coords.accuracy, color: "#2a7de1", weight: 1, fillOpacity: .12, interactive: false }).addTo(st.map);
      st.me = L.circleMarker(ll, { radius: 8, color: "#fff", weight: 3, fillColor: "#2a7de1", fillOpacity: 1 }).addTo(st.map);
    } else { st.me.setLatLng(ll); st.acc.setLatLng(ll).setRadius(p.coords.accuracy); }
    if (first) { st.map.setView(ll, Math.max(st.map.getZoom(), 15)); first = false; document.getElementById("mloc").classList.add("on"); }
  }, err => {
    toast(err.code === 1 ? "位置情報の利用が許可されていません（設定で許可してください）" : "現在地を取得できませんでした", 4500);
    if (st.watch != null) navigator.geolocation.clearWatch(st.watch); st.watch = null;
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}

function updateMapInfo(extra) {
  const el = document.getElementById("minfo"); if (!el || !mapState) return;
  const r = mapState.r, a = areaOnDevice(r.id);
  let t = a ? "✓ この端末に地図を保存済み（" + new Date(a.date).toLocaleDateString("ja-JP") + "・約" + Math.round(a.count * KB_PER_TILE / 1024) + "MB）。圏外でも点線の枠内が見られます。"
    : r.mapArea ? "別の端末で保存した範囲があります（点線の枠）。この端末にも保存するには「⋯」→「点線の範囲を保存」を押してください。"
      : "地図を動かして、保存したい範囲を画面に表示してから「この範囲を保存」を押してください。";
  if (r.gpx) t += "　GPX：" + esc(r.gpx.name || "読み込み済み");
  el.innerHTML = extra || t;
}

function mapMenu() {
  const st = mapState; if (!st) return; const r = st.r;
  const a = areaOnDevice(r.id);
  const m = document.createElement("div"); m.className = "modal";
  m.innerHTML = '<div class="box"><h3 style="margin-top:0">地図メニュー</h3><div style="display:flex;flex-direction:column;gap:8px">' +
    '<button class="btn" id="g1">📄 GPXファイルを読み込む</button>' +
    (r.gpx ? '<button class="btn" id="g2">GPXのルート線を消す</button>' : '') +
    (r.mapArea && !a ? '<button class="btn primary" id="g5">点線の範囲をこの端末に保存</button>' : '') +
    (a ? '<button class="btn danger" id="g3">保存した地図をこの端末から削除</button>' : '') +
    '<button class="btn" id="g4">閉じる</button></div>' +
    '<p class="muted" style="font-size:12px;margin-bottom:0" id="gst"></p></div>';
  document.body.appendChild(m);
  m.onclick = ev => { if (ev.target === m) m.remove(); };
  m.querySelector("#g4").onclick = () => m.remove();
  m.querySelector("#g1").onclick = () => { m.remove(); document.getElementById("mgpx").click(); };
  const g2 = m.querySelector("#g2"); if (g2) g2.onclick = () => { m.remove(); confirmBox("GPXのルート線を消しますか？", () => { const nr = JSON.parse(JSON.stringify(r)); nr.gpx = null; writeRoute(nr); setTimeout(() => { const x = find(r.id); if (x) renderMap(x); }, 100); }); };
  const g3 = m.querySelector("#g3"); if (g3) g3.onclick = () => { m.remove(); confirmBox("この端末に保存した地図を削除しますか？（ルートの情報は消えません）", () => deleteArea(r.id)); };
  const g5 = m.querySelector("#g5"); if (g5) g5.onclick = () => { m.remove(); startDownload(r.mapArea); };
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => {
    const el = m.querySelector("#gst"); if (el) el.textContent = "この端末で使っている容量：約" + Math.round((e.usage || 0) / 1048576) + "MB";
  }).catch(() => {});
}

function startDownload(area) {
  const st = mapState; if (!st) return;
  if (!navigator.onLine) { toast("地図の保存には電波が必要です"); return; }
  const n = countTiles(area);
  if (n > TILE_LIMIT) { toast("範囲が広すぎます（約" + n + "枚）。もう少し拡大して範囲を狭めてください", 5000); return; }
  const mb = Math.max(1, Math.round(n * KB_PER_TILE / 1024));
  confirmBox("表示中の範囲の地図を保存します。\n（ズーム" + Z_MIN + "〜" + Z_MAX + "、約" + n + "枚・約" + mb + "MB）\nWi-Fiでの保存がおすすめです。", () => downloadArea(st.r, area), "保存する", true);
}

async function downloadArea(r, area) {
  const st = mapState; if (!st) return;
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
  const urls = tilesIn(area), cache = await caches.open(TILE_CACHE);
  let done = 0, failed = 0, i = 0;
  const btn = document.getElementById("mdl"); if (btn) btn.disabled = true;
  const show = () => updateMapInfo('<div class="prog"><div style="width:' + Math.round(done / urls.length * 100) + '%"></div></div>地図を保存中… ' + done + ' / ' + urls.length + (failed ? '（失敗 ' + failed + '）' : '') + '　<a href="#" id="mstop">中止</a>');
  show();
  const bindStop = () => { const s = document.getElementById("mstop"); if (s) s.onclick = ev => { ev.preventDefault(); if (mapState) mapState.cancel = true; }; };
  bindStop();
  async function worker() {
    while (i < urls.length) {
      if (!mapState || mapState.cancel) return;
      const u = urls[i++];
      try {
        if (!(await cache.match(u))) {
          const res = await fetch(u, { mode: "cors" });
          if (res.ok) await cache.put(u, res); else if (res.status !== 404) failed++; // 404は海などタイルが無い場所
        }
      } catch (e) { failed++; }
      done++;
      if (done % 20 === 0 || done === urls.length) { show(); bindStop(); }
      await new Promise(res => setTimeout(res, 15)); // サーバーに負担をかけないよう少し間をあける
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (btn) btn.disabled = false;
  if (!mapState) return;
  if (mapState.cancel) { mapState.cancel = false; updateMapInfo(); toast("保存を中止しました（途中までは保存されています）"); return; }
  const areas = localAreas(); areas[r.id] = Object.assign({}, area, { count: urls.length, date: Date.now() }); saveLocalAreas(areas);
  const cur = find(r.id) || r;
  if (JSON.stringify(cur.mapArea || null) !== JSON.stringify(area)) { const nr = JSON.parse(JSON.stringify(cur)); nr.mapArea = area; writeRoute(nr); mapState.r = nr; }
  if (mapState.rect) mapState.rect.remove();
  mapState.rect = L.rectangle([[area.s, area.w], [area.n, area.e]], { color: "#2f5d45", weight: 2, dashArray: "6 6", fill: false, interactive: false }).addTo(mapState.map);
  updateMapInfo();
  toast(failed ? "保存しました（" + failed + "枚は取得できませんでした。もう一度押すと続きを保存します）" : "地図を保存しました。圏外でも見られます", 5000);
}

async function deleteArea(id) {
  const areas = localAreas(), a = areas[id]; if (!a) return;
  delete areas[id];
  const keep = new Set(); Object.values(areas).forEach(o => tilesIn(o).forEach(u => keep.add(u))); // 他のルートと重なる部分は残す
  const cache = await caches.open(TILE_CACHE);
  await Promise.all(tilesIn(a).filter(u => !keep.has(u)).map(u => cache.delete(u)));
  saveLocalAreas(areas);
  toast("この端末の地図を削除しました");
  if (mapState) updateMapInfo();
}

async function importGpx(r, file) {
  try {
    const xml = new DOMParser().parseFromString(await file.text(), "application/xml");
    let pts = [...xml.getElementsByTagName("trkpt")]; if (!pts.length) pts = [...xml.getElementsByTagName("rtept")];
    let ll = pts.map(p => [+(+p.getAttribute("lat")).toFixed(5), +(+p.getAttribute("lon")).toFixed(5)]).filter(p => isFinite(p[0]) && isFinite(p[1]));
    if (ll.length > 4000) { const k = Math.ceil(ll.length / 4000); ll = ll.filter((p, i) => i % k === 0 || i === ll.length - 1); } // 間引いて保存容量を抑える
    const wpts = [...xml.getElementsByTagName("wpt")].slice(0, 200).map(w => ({ lat: +(+w.getAttribute("lat")).toFixed(5), lng: +(+w.getAttribute("lon")).toFixed(5), name: ((w.getElementsByTagName("name")[0] || {}).textContent || "").trim().slice(0, 40) }));
    if (!ll.length && !wpts.length) { toast("GPXにルートが見つかりませんでした"); return; }
    const nmEl = xml.querySelector("trk > name") || xml.querySelector("rte > name") || xml.querySelector("metadata > name");
    const nm = ((nmEl && nmEl.textContent) || file.name.replace(/\.gpx$/i, "")).trim().slice(0, 60);
    const nr = JSON.parse(JSON.stringify(find(r.id) || r)); nr.gpx = { name: nm, pts: ll, wpts }; nr.updated = Date.now();
    writeRoute(nr); toast("GPXを読み込みました");
    setTimeout(() => { const x = find(r.id); if (x) renderMap(x); }, 100);
  } catch (e) { toast("GPXを読み込めませんでした"); }
}
