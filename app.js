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
let ui = { q: "", lv: "", sort: "mountain", done: "" };
try { const s = JSON.parse(localStorage.getItem("yama-ui") || "null"); if (s) ui = Object.assign(ui, s); } catch (e) {}
function persistUi() { try { localStorage.setItem("yama-ui", JSON.stringify(ui)); } catch (e) {} }

/* ---------- helpers ---------- */
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function toast(msg, ms) { const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), ms || 2600); }
function safeUrl(u) { u = String(u || "").trim(); if (!u) return ""; if (!/^https?:\/\//i.test(u)) u = "https://" + u; return u; }
function climbsOf(r) { return (r.climbs || []).slice().sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0); }
function fmtDate(d) { if (!d) return ""; const p = d.split("-"); return p.length === 3 ? p[0] + "/" + (+p[1]) + "/" + (+p[2]) : d; }
function today() { const t = new Date(); t.setMinutes(t.getMinutes() - t.getTimezoneOffset()); return t.toISOString().slice(0, 10); }
function mountainTotal(name) { let n = 0; routes.forEach(r => { if ((r.mountain || "") === name) n += (r.climbs || []).length; }); return n; }
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
  if (h === "new") return renderForm(null);
  let m = h.match(/^edit-(.+)$/); if (m) return renderForm(find(m[1]));
  m = h.match(/^r-(.+)$/); if (m) { const r = find(m[1]); if (r) return renderDetail(r); }
  renderList();
}
function currentView() { const h = location.hash; return h === "#new" || /^#edit-/.test(h) ? "form" : /^#r-/.test(h) ? "detail" : "list"; }
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
function lvBadge(l) { return l ? '<span class="lv ' + (LVCLS[l] || "lv0") + '">' + esc(l) + '</span>' : ""; }
function shortTime(t) { t = String(t); return t.length > 22 ? t.slice(0, 22) + "…" : t; }
function card(r) {
  const chips = [];
  if (r.time) chips.push('<span class="chip">⏱ ' + esc(shortTime(r.time)) + '</span>');
  if (r.distance) chips.push('<span class="chip">↔ ' + esc(r.distance) + ' km</span>');
  const cl = climbsOf(r); if (cl.length) chips.push('<span class="chip">最終 ' + esc(fmtDate(cl[0].date)) + '</span>');
  const t = imgSrc(r.thumb);
  return '<button class="card" data-id="' + esc(r.id) + '"><div class="thumb">' + (t ? '<img loading="lazy" src="' + t + '" alt="">' : '<div class="ph">' + MTN + '</div>') +
    (r.level ? '<span class="badge-on">' + lvBadge(r.level) + '</span>' : '') + (cl.length ? '<span class="done">✓ 登頂 ' + cl.length + '回</span>' : '') + '</div>' +
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
    '<div class="toolbar"><input id="q" type="search" placeholder="山名・ルート名・エリアで検索" value="' + esc(ui.q) + '">' +
    '<select id="lv"><option value="">難易度：すべて</option>' + LEVELS.map(l => '<option' + sel("lv", l) + '>' + l + '</option>').join("") + '</select>' +
    '<select id="sort"><option value="mountain"' + sel("sort", "mountain") + '>山の名前順</option><option value="level"' + sel("sort", "level") + '>難易度順</option><option value="climbs"' + sel("sort", "climbs") + '>登頂回数が多い順</option><option value="updated"' + sel("sort", "updated") + '>更新が新しい順</option></select>' +
    '<select id="done"><option value="">登頂：すべて</option><option value="done"' + sel("done", "done") + '>登頂済み</option><option value="not"' + sel("done", "not") + '>未登頂</option></select></div>' +
    summaryHtml() + '<div class="count">' + list.length + ' 件</div>';
  if (!routes.length) html += '<div class="empty">まだルートがありません。<br>「＋ ルートを追加」から登録しましょう。</div>';
  else if (!list.length) html += '<div class="empty">条件に合うルートがありません。</div>';
  else if (ui.sort === "mountain" || ui.sort === "climbs") {
    const groups = {}, order = [];
    list.forEach(r => { const k = r.mountain || "（山名なし）"; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(r); });
    order.forEach(k => { const t = mountainTotal(k); html += '<div class="group-title">' + esc(k) + '　' + groups[k].length + 'ルート' + (t ? '<span class="gcount">⛰ 登頂 ' + t + '回</span>' : '') + '</div><div class="grid">' + groups[k].map(card).join("") + '</div>'; });
  } else html += '<div class="grid">' + list.map(card).join("") + '</div>';
  app.innerHTML = html;
  const qi = document.getElementById("q");
  qi.addEventListener("input", () => { ui.q = qi.value; persistUi(); const pos = qi.selectionStart; renderList(); const n = document.getElementById("q"); n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} });
  document.getElementById("lv").onchange = e => { ui.lv = e.target.value; persistUi(); renderList(); };
  document.getElementById("sort").onchange = e => { ui.sort = e.target.value; persistUi(); renderList(); };
  document.getElementById("done").onchange = e => { ui.done = e.target.value; persistUi(); renderList(); };
  document.getElementById("add").onclick = () => go("new");
  document.getElementById("menu").onclick = openMenu;
  app.querySelectorAll(".card").forEach(c => { c.onclick = () => go("r-" + c.dataset.id); });
}
function openMenu() {
  const m = document.createElement("div"); m.className = "modal";
  m.innerHTML = '<div class="box"><h3 style="margin-top:0">メニュー</h3><p class="muted" style="font-size:13px">ログイン中：' + esc(user.email || "") + '</p>' +
    '<div style="display:flex;flex-direction:column;gap:8px"><button class="btn" id="mexp">バックアップを書き出す（画像込み）</button><button class="btn" id="mimp">バックアップを読み込む</button><button class="btn danger" id="mout">ログアウト</button><button class="btn" id="mcl">閉じる</button></div>' +
    '<input type="file" id="mfile" accept=".json,application/json" hidden></div>';
  document.body.appendChild(m);
  m.onclick = ev => { if (ev.target === m) m.remove(); };
  m.querySelector("#mcl").onclick = () => m.remove();
  m.querySelector("#mexp").onclick = () => { exportData(); m.remove(); };
  const f = m.querySelector("#mfile");
  m.querySelector("#mimp").onclick = () => f.click();
  f.onchange = () => { if (f.files[0]) importData(f.files[0]); m.remove(); };
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
  let html = '<div class="back" style="display:flex;gap:8px;align-items:center"><button class="btn small" id="back">← 一覧へ</button>' + statusHtml() + '</div>' +
    '<div class="hero">' + (t ? '<img id="heroimg" src="' + t + '" alt="">' : '<div class="ph">' + MTN + '</div>') + '</div>' +
    '<div class="dhead"><div><h2>' + esc(r.mountain || "（山名なし）") + '</h2><div class="rt">' + esc(r.route || "") + '</div></div><div class="spacer"></div>' + lvBadge(r.level) +
    '<button class="btn small" id="edit">✎ 編集</button></div>' +
    (r.area ? '<div class="muted">📍 ' + esc(r.area) + '</div>' : '') +
    '<div class="stats">' + stat("難易度", r.level) + stat("所要時間", r.time) + stat("距離", r.distance, " km") + (r.elevation ? stat("標高差・累積標高", r.elevation) : "") + stat("駐車場", r.parking) + stat("駐車料金", r.parkingFee) + '</div>';
  const cl = climbsOf(r), mt = mountainTotal(r.mountain || "");
  html += '<div class="sec"><h3>⛰ 登頂記録<span class="bigcount">このルート <b>' + cl.length + '</b>回' + (mt !== cl.length ? '　／　' + esc(r.mountain) + ' 合計 <b>' + mt + '</b>回' : '') + '</span></h3>' +
    (cl.length ? '<ul class="climbs">' + cl.map((c, i) => '<li><span class="n">' + (cl.length - i) + '回目</span><span class="d">' + esc(fmtDate(c.date)) + '</span><span class="m">' + esc(c.memo || "") + '</span><button class="x" data-cid="' + esc(c.id) + '" aria-label="削除">×</button></li>').join("") + '</ul>' : '<div class="muted">まだ登頂記録がありません</div>') +
    '<div class="addclimb"><input type="date" id="cdate" value="' + today() + '"><input type="text" id="cmemo" placeholder="ひとこと（天気・一緒に行った人など）"><button class="btn primary small" id="cadd">＋ 登頂を記録</button></div></div>';
  if (r.caution) html += '<div class="sec warn"><h3>⚠️ 注意点</h3><div class="pre">' + esc(r.caution) + '</div></div>';
  html += '<div class="sec"><h3>🗺 地図・写真</h3>' + (maps.length ? '<div class="gallery">' + maps.map((m, i) => '<figure><img loading="lazy" data-i="' + (i + (r.thumb ? 1 : 0)) + '" src="' + imgSrc(m.img) + '" alt="">' + (m.caption ? '<figcaption>' + esc(m.caption) + '</figcaption>' : '') + '</figure>').join("") + '</div>' : '<div class="muted">まだ画像がありません</div>') + '</div>';
  html += '<div class="sec"><h3>🔗 参考リンク</h3>' + (urls.length ? '<ul class="links">' + urls.map(u => { const href = safeUrl(u.url); const yt = /youtu\.?be/i.test(href); return '<li><a href="' + esc(href) + '" target="_blank" rel="noopener">' + (yt ? "▶️" : "🌐") + ' <span class="lbl">' + esc(u.label || href) + '</span></a>' + (u.label ? ' <span class="u">' + esc(href) + '</span>' : '') + '</li>'; }).join("") + '</ul>' : '<div class="muted">リンクなし</div>') + '</div>';
  html += '<div class="sec"><h3>📝 備考</h3>' + (r.memo ? '<div class="pre">' + esc(r.memo) + '</div>' : '<div class="muted">—</div>') + '</div>';
  html += '<div class="muted" style="font-size:12px;text-align:right">最終更新：' + (r.updated ? new Date(r.updated).toLocaleDateString("ja-JP") : "—") + '</div>';
  app.innerHTML = html;
  document.getElementById("back").onclick = () => go("");
  document.getElementById("edit").onclick = () => go("edit-" + r.id);
  document.getElementById("cadd").onclick = () => {
    const d = document.getElementById("cdate").value; if (!d) { toast("日付を選んでください"); return; }
    const nr = JSON.parse(JSON.stringify(r)); nr.climbs = (nr.climbs || []).concat([{ id: uid(), date: d, memo: document.getElementById("cmemo").value.trim() }]); nr.updated = Date.now();
    writeRoute(nr); toast(status.offline ? "記録しました（電波が戻ったら送信されます）" : "記録しました");
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
  const r = orig ? JSON.parse(JSON.stringify(orig)) : { id: uid(), mountain: "", route: "", area: "", level: "", time: "", distance: "", elevation: "", parking: "", parkingFee: "", urls: [], caution: "", memo: "", thumb: null, maps: [], climbs: [] };
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
function confirmBox(msg, ok, label) {
  const m = document.createElement("div"); m.className = "modal";
  m.innerHTML = '<div class="box"><p style="margin-top:0">' + esc(msg) + '</p><div class="actions"><button class="btn" id="cn">キャンセル</button><button class="btn primary" id="ok" style="background:#a33b3b;border-color:#a33b3b">' + esc(label || "削除する") + '</button></div></div>';
  document.body.appendChild(m); m.querySelector("#cn").onclick = () => m.remove(); m.querySelector("#ok").onclick = () => { m.remove(); ok(); };
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
    if (sig !== routesSig) { routesSig = sig; routes = next; if (currentView() !== "form") route(); }
    else updateStatus();
  }, e => toast("読み込みエラー：" + (e.code || e.message), 5000)));
  unsub.push(onSnapshot(imagesCol(), snap => {
    let changed = false;
    snap.docChanges().forEach(c => { if (c.type === "removed") delete images[c.doc.id]; else images[c.doc.id] = c.doc.data().data; changed = true; });
    if (changed && currentView() !== "form") route();
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

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
