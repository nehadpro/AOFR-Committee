// ================================================================
// اللجنة الدائمة لتنفيذ آلية التجديد — منطق التطبيق
// ================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, updateDoc,
  deleteDoc, addDoc, onSnapshot, query, where, orderBy, serverTimestamp, deleteField
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const fbApp = initializeApp(window.FIREBASE_CONFIG);
const db = getFirestore(fbApp);

// ---------------- constants ----------------
const DECISION_OPTIONS = [
  { value: "approve", label: "الموافقة", pill: "pill-approve" },
  { value: "reject", label: "عدم الموافقة", pill: "pill-reject" },
  { value: "extend", label: "الموافقة لسنة أخيرة", pill: "pill-extend" },
  { value: "extend_align", label: "الموافقة لسنة أخيرة والمواءمة مع لجنة تخطيط الموارد البشرية", pill: "pill-extend-align" },
  { value: "other", label: "أخرى", pill: "pill-other" },
];
const optionByValue = (v) => DECISION_OPTIONS.find((o) => o.value === v);

// ---------------- Hijri (Umm al-Qura) calendar helpers ----------------
// Relies on the browser's built-in Intl support for the "islamic-umalqura"
// calendar (works well in Chrome/Edge; other browsers may have partial
// support). No external library is needed.
const HIJRI_MONTHS = ["محرم", "صفر", "ربيع الأول", "ربيع الآخر", "جمادى الأولى", "جمادى الآخرة", "رجب", "شعبان", "رمضان", "شوال", "ذو القعدة", "ذو الحجة"];

function gregorianToHijriParts(dateObj) {
  const fmt = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", { year: "numeric", month: "numeric", day: "numeric" });
  const parts = fmt.formatToParts(dateObj);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { day: get("day"), month: get("month"), year: get("year") };
}

const HIJRI_SEARCH_START = new Date(Date.UTC(1937, 0, 1));
const HIJRI_SEARCH_END = new Date(Date.UTC(2077, 0, 1));
function hijriToGregorian(hy, hm, hd) {
  const target = hy * 10000 + hm * 100 + hd;
  let lo = 0, hi = Math.round((HIJRI_SEARCH_END - HIJRI_SEARCH_START) / 86400000);
  const keyForOffset = (off) => {
    const d = new Date(HIJRI_SEARCH_START.getTime() + off * 86400000);
    const p = gregorianToHijriParts(d);
    return p.year * 10000 + p.month * 100 + p.day;
  };
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (keyForOffset(mid) < target) lo = mid + 1; else hi = mid;
  }
  return new Date(HIJRI_SEARCH_START.getTime() + lo * 86400000);
}
function isoFromDateUTC(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function hijriLabel(dateObjOrIso) {
  if (!dateObjOrIso) return null;
  const d = typeof dateObjOrIso === "string" ? new Date(dateObjOrIso + "T00:00:00Z") : dateObjOrIso;
  if (isNaN(d)) return null;
  try {
    const p = gregorianToHijriParts(d);
    return `${p.day} ${HIJRI_MONTHS[p.month - 1]} ${p.year}هـ`;
  } catch { return null; }
}
function fmtDateBoth(isoDate) {
  if (!isoDate) return "—";
  const greg = fmtDate(isoDate);
  const hij = hijriLabel(isoDate);
  return hij ? `${hij} (الموافق ${greg}م)` : greg;
}

const ROLE_LABEL = { chair: "رئيس اللجنة", secretary: "أمين اللجنة", member: "عضو" };

// ---------------- tiny utils ----------------
function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
function el(tag, attrs = {}, html) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  if (html !== undefined) node.innerHTML = html;
  return node;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(input) {
  if (!input) return "—";
  try {
    const d = typeof input === "string" ? new Date(input) : input.toDate ? input.toDate() : input;
    if (isNaN(d)) return input;
    return d.toLocaleDateString("ar-SA-u-ca-gregory", { year: "numeric", month: "long", day: "numeric" });
  } catch { return String(input); }
}
async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function toast(msg) {
  const root = $("#toastRoot");
  root.innerHTML = "";
  const t = el("div", { class: "toast" }, esc(msg));
  root.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
function closeModal() { $("#modalRoot").innerHTML = ""; }
function openModal({ title, bodyHTML, onMount, foot }) {
  const root = $("#modalRoot");
  root.innerHTML = "";
  const backdrop = el("div", { class: "modal-backdrop" });
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });
  const modal = el("div", { class: "modal" });
  modal.innerHTML = `
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" id="modalCloseBtn">✕</button></div>
    <div class="modal-body">${bodyHTML}</div>
    <div class="modal-foot" id="modalFoot"></div>`;
  backdrop.appendChild(modal);
  root.appendChild(backdrop);
  $("#modalCloseBtn").addEventListener("click", closeModal);
  if (foot) $("#modalFoot").appendChild(foot);
  if (onMount) onMount(modal);
  return modal;
}

// ---------------- session ----------------
const SESSION_KEY = "ltj_session_v1";
function saveSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
function readSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } }
function clearSession() { localStorage.removeItem(SESSION_KEY); }

let CURRENT = null; // { type: 'admin' } | { type:'member', id, name, username, role }
let activeUnsubs = [];
function teardown() { activeUnsubs.forEach((u) => { try { u(); } catch {} }); activeUnsubs = []; }

// ================================================================
// LOGIN SCREEN WIRING
// ================================================================
const loginScreen = $("#loginScreen");
const appShell = $("#appShell");
const memberSelect = $("#memberSelect");
const loginError = $("#loginError");

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove("hidden");
}
function hideLoginError() { loginError.classList.add("hidden"); }

$all(".login-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $all(".login-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    hideLoginError();
    const isMember = tab.dataset.tab === "member";
    $("#memberLoginForm").classList.toggle("hidden", !isMember);
    $("#adminLoginForm").classList.toggle("hidden", isMember);
  });
});

function sortMembersForDisplay(members) {
  return [...members].sort((a, b) => {
    const oa = a.order ?? 9999, ob = b.order ?? 9999;
    if (oa !== ob) return oa - ob;
    return (a.name || "").localeCompare(b.name || "", "ar");
  });
}

async function populateMemberList() {
  memberSelect.innerHTML = '<option value="" disabled selected>اختر اسمك من القائمة…</option>';
  const snap = await getDocs(collection(db, "members"));
  const members = sortMembersForDisplay(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  members.forEach((m) => {
    if (m.active === false) return;
    memberSelect.appendChild(el("option", { value: m.id }, `${esc(m.name)} — ${esc(ROLE_LABEL[m.role] || "عضو")}`));
  });
}

function setPasswordFieldVisible(visible) {
  $("#memberPasswordField").style.display = visible ? "flex" : "none";
  $("#memberPassword").value = "";
}

// ---- switch between "pick a name" and "type an email" login modes ----
const memberUsernameInput = $("#memberUsernameInput");
let loginMode = "select";
function setLoginMode(mode) {
  loginMode = mode;
  $all(".login-subtab").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  const selectWrap = $("#memberSelectWrap");
  const typeWrap = $("#memberUsernameWrap");
  selectWrap.classList.toggle("hidden", mode !== "select");
  typeWrap.classList.toggle("hidden", mode !== "type");
  selectWrap.style.display = mode === "select" ? "flex" : "none";
  typeWrap.style.display = mode === "type" ? "flex" : "none";
  memberSelect.value = "";
  memberUsernameInput.value = "";
  setPasswordFieldVisible(false);
  hideLoginError();
}
$all(".login-subtab").forEach((b) => b.addEventListener("click", () => setLoginMode(b.dataset.mode)));

memberSelect.addEventListener("change", async () => {
  const id = memberSelect.value;
  if (!id) return setPasswordFieldVisible(false);
  const snap = await getDoc(doc(db, "members", id));
  setPasswordFieldVisible(!!(snap.exists() && snap.data().passwordHash));
});

memberUsernameInput.addEventListener("blur", async () => {
  const uname = memberUsernameInput.value.trim();
  if (!uname) return setPasswordFieldVisible(false);
  const snap = await getDocs(query(collection(db, "members"), where("username", "==", uname)));
  setPasswordFieldVisible(!snap.empty && !!snap.docs[0].data().passwordHash);
});

$("#memberLoginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideLoginError();
  let id, m;
  if (loginMode === "type") {
    const uname = memberUsernameInput.value.trim();
    if (!uname) return showLoginError("الرجاء إدخال بريدك الجامعي");
    const snap = await getDocs(query(collection(db, "members"), where("username", "==", uname)));
    if (snap.empty) return showLoginError("لم يتم العثور على عضو بهذا البريد");
    id = snap.docs[0].id; m = snap.docs[0].data();
  } else {
    id = memberSelect.value;
    if (!id) return showLoginError("الرجاء اختيار اسمك أولًا");
    const snap = await getDoc(doc(db, "members", id));
    if (!snap.exists()) return showLoginError("تعذر العثور على هذا العضو");
    m = snap.data();
  }
  if (m.active === false) { $("#memberPassword").value = ""; return showLoginError("هذا الحساب معطّل حاليًا"); }
  if (m.passwordHash) {
    const pass = $("#memberPassword").value;
    $("#memberPassword").value = "";
    const hash = await sha256(pass || "");
    if (hash !== m.passwordHash) return showLoginError("كلمة المرور غير صحيحة");
  }
  CURRENT = { type: "member", id, name: m.name, username: m.username, role: m.role };
  saveSession(CURRENT);
  enterApp();
});

$("#adminLoginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  hideLoginError();
  const u = $("#adminUser").value.trim();
  const p = $("#adminPass").value;
  $("#adminPass").value = "";
  const creds = window.ADMIN_CREDENTIALS || {};
  if (u === creds.username && p === creds.password) {
    CURRENT = { type: "admin", name: "المسؤول" };
    saveSession(CURRENT);
    enterApp();
  } else {
    showLoginError("بيانات دخول المسؤول غير صحيحة");
  }
});

$("#logoutBtn").addEventListener("click", () => {
  teardown();
  clearSession();
  CURRENT = null;
  appShell.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  $("#memberLoginForm").reset();
  $("#adminLoginForm").reset();
  setLoginMode("select");
  populateMemberList();
});

// ================================================================
// APP ENTRY
// ================================================================
function enterApp() {
  loginScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  $("#whoName").textContent = CURRENT.type === "admin" ? "المسؤول" : `${CURRENT.name} (${ROLE_LABEL[CURRENT.role] || "عضو"})`;
  const cpBtn = $("#changePasswordTopBtn");
  if (CURRENT.type === "member") {
    cpBtn.classList.remove("hidden");
    cpBtn.onclick = openChangePasswordModal;
  } else {
    cpBtn.classList.add("hidden");
  }
  if (CURRENT.type === "admin") renderAdminShell();
  else renderMemberShell();
}

(async function bootstrap() {
  await populateMemberList();
  const s = readSession();
  if (s) {
    if (s.type === "admin") { CURRENT = s; enterApp(); return; }
    if (s.type === "member" && s.id) {
      const snap = await getDoc(doc(db, "members", s.id));
      if (snap.exists() && snap.data().active !== false) {
        const m = snap.data();
        CURRENT = { type: "member", id: s.id, name: m.name, username: m.username, role: m.role };
        enterApp();
        return;
      } else { clearSession(); }
    }
  }
})();

// ================================================================
// MEMBER WORKSPACE
// ================================================================
let memberRosterCache = [];
let lastRenderedMemberCommittee = null;
let lastRenderedMemberTopics = null;
function renderMemberShell() {
  teardown();
  $("#sidebar").innerHTML = `<div class="nav-label">اللجنة الحالية</div>`;
  const main = $("#mainView");
  main.innerHTML = `<div id="memberRoot"></div>`;

  getDocs(collection(db, "members")).then((snap) => {
    memberRosterCache = sortMembersForDisplay(snap.docs.map((d) => ({ id: d.id, ...d.data() }))).filter((m) => m.active !== false);
    if (lastRenderedMemberTopics) renderMemberTopics(lastRenderedMemberCommittee, lastRenderedMemberTopics);
  });

  const qOpen = query(collection(db, "committees"), where("status", "==", "مفتوحة"), orderBy("createdAt", "desc"));
  const unsub = onSnapshot(qOpen, (snap) => {
    const committees = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderMemberCommitteePicker(committees);
  }, (err) => renderMemberError(err));
  activeUnsubs.push(unsub);
}

function renderMemberError(err) {
  $("#memberRoot").innerHTML = `<div class="card card-pad"><div class="empty-state"><div class="display">تعذّر الاتصال بقاعدة البيانات</div><div class="text-sm">${esc(err.message || err)}</div></div></div>`;
}

let memberCurrentCommitteeId = null;
function renderMemberCommitteePicker(committees) {
  const sidebar = $("#sidebar");
  if (!committees.length) {
    sidebar.innerHTML = `<div class="nav-label">اللجنة الحالية</div>`;
    $("#memberRoot").innerHTML = `<div class="card card-pad"><div class="empty-state"><div class="display">لا توجد لجنة مفتوحة حاليًا</div><div class="text-sm">سيتم إشعارك هنا عند فتح لجنة جديدة للتصويت</div></div></div>`;
    return;
  }
  if (!memberCurrentCommitteeId || !committees.find((c) => c.id === memberCurrentCommitteeId)) {
    memberCurrentCommitteeId = committees[0].id;
  }
  sidebar.innerHTML = `<div class="nav-label">اللجان المفتوحة</div>`;
  committees.forEach((c) => {
    const btn = el("button", {
      class: "nav-item" + (c.id === memberCurrentCommitteeId ? " active" : ""),
      onclick: () => { memberCurrentCommitteeId = c.id; renderMemberCommitteePicker(committees); loadMemberTopics(c); },
    }, esc(c.number));
    sidebar.appendChild(btn);
  });
  const committee = committees.find((c) => c.id === memberCurrentCommitteeId);
  loadMemberTopics(committee);
}

let memberTopicsUnsub = null;
let memberSelectedTopicId = null;
function loadMemberTopics(committee) {
  if (memberTopicsUnsub) memberTopicsUnsub();
  const topicsQ = query(collection(db, "committees", committee.id, "topics"), orderBy("order"));
  memberTopicsUnsub = onSnapshot(topicsQ, (snap) => {
    const topics = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderMemberTopics(committee, topics);
  }, (err) => renderMemberError(err));
  activeUnsubs.push(memberTopicsUnsub);
}

function renderMemberTopics(committee, topics) {
  lastRenderedMemberCommittee = committee;
  lastRenderedMemberTopics = topics;
  const root = $("#memberRoot");
  if (!topics.length) {
    root.innerHTML = `<div class="card card-pad"><div class="empty-state"><div class="display">لا توجد موضوعات في هذه اللجنة بعد</div><div class="text-sm">سيقوم المسؤول بإضافتها قريبًا</div></div></div>`;
    return;
  }
  if (!memberSelectedTopicId || !topics.find((t) => t.id === memberSelectedTopicId)) {
    memberSelectedTopicId = topics.find((t) => !(t.decisions && t.decisions[CURRENT.id]))?.id || topics[0].id;
  }

  const decided = topics.filter((t) => t.decisions && t.decisions[CURRENT.id]).length;

  root.innerHTML = `
    <div class="main-header">
      <div>
        <h2>${esc(committee.number)}</h2>
        <div class="sub">${fmtDate(committee.date)} · <span class="status-chip status-active">مفتوحة للتصويت</span></div>
      </div>
      <div class="main-actions"><div class="text-sm muted">أنجزت ${decided} من ${topics.length} موضوعًا</div></div>
    </div>
    <div style="display:flex; gap:20px; align-items:flex-start;">
      <div style="width:230px; flex-shrink:0;">
        <div class="topic-list" id="memberTopicList"></div>
      </div>
      <div style="flex:1; min-width:0;">
        <div class="card" id="memberDossier"></div>
      </div>
    </div>`;

  const list = $("#memberTopicList");
  topics.forEach((t, i) => {
    const done = !!(t.decisions && t.decisions[CURRENT.id]);
    const chip = el("button", {
      class: "topic-chip" + (t.id === memberSelectedTopicId ? " current" : "") + (done ? " done" : ""),
      onclick: () => { memberSelectedTopicId = t.id; renderMemberTopics(committee, topics); },
    });
    chip.innerHTML = `<span class="num">${i + 1}</span><span class="name">${esc(t.researcherName || t.fileNumber || "بدون اسم")}</span><span class="status-dot"></span>`;
    list.appendChild(chip);
  });

  const topic = topics.find((t) => t.id === memberSelectedTopicId);
  renderMemberDossier(committee, topic, topics.findIndex((t) => t.id === topic.id) + 1);
}

function renderMemberDossier(committee, topic, indexNum) {
  const box = $("#memberDossier");
  const myDecision = topic.decisions && topic.decisions[CURRENT.id];
  const decisions = topic.decisions || {};
  const decidedCount = Object.keys(decisions).length;
  const closed = committee.status !== "مفتوحة";

  box.innerHTML = `
    <div class="dossier-head">
      <div class="file-no">الموضوع رقم ${indexNum} — ${esc(topic.researcherName || "بدون اسم")}</div>
      <span class="badge">الرقم الوظيفي ${esc(topic.fileNumber || "—")}</span>
    </div>
    <div class="dossier-grid">
      <div class="dossier-field"><div class="k">الجهة التي يعمل بها</div><div class="v">${esc(topic.entity || "—")}</div></div>
      <div class="dossier-field"><div class="k">تاريخ نهاية العقد</div><div class="v">${fmtDateBoth(topic.contractEndDate)}</div></div>
      <div class="dossier-field"><div class="k">المؤهل</div><div class="v">${esc(topic.qualification || "—")}</div></div>
      <div class="dossier-field"><div class="k">التخصص</div><div class="v">${esc(topic.specialization || "—")}</div></div>
      <div class="dossier-field"><div class="k">السن</div><div class="v">${esc(topic.age ?? "—")}</div></div>
      <div class="dossier-field"><div class="k">اسم المشرف</div><div class="v">${esc(topic.supervisorName || "—")}</div></div>
      <div class="dossier-field full"><div class="k">نبذة عن طبيعة العمل والمهام المسندة إليه</div><div class="v">${esc(topic.jobDescription || "—")}</div></div>
      <div class="dossier-field"><div class="k">قرار اللجنة السابق حياله</div><div class="v muted">${esc(topic.previousDecision || "لا يوجد")}</div></div>
      <div class="dossier-field"><div class="k">العدد الإجمالي للباحثين بنفس الجهة</div><div class="v">${esc(topic.colleaguesCount ?? "—")}</div></div>
      <div class="dossier-field full"><div class="k">المرفقات</div><div id="memberAttachments" class="v"><span class="text-sm muted">جارِ التحميل…</span></div></div>
    </div>
    <div class="decision-panel" style="flex-direction:column; align-items:stretch;">
      <div class="row" style="align-items:flex-end; flex-wrap:wrap;">
        <div class="field">
          <label for="decisionSelect">قرارك بخصوص هذا الموضوع</label>
          <select id="decisionSelect" ${closed ? "disabled" : ""}>
            <option value="" disabled ${!myDecision ? "selected" : ""}>اختر القرار…</option>
            ${DECISION_OPTIONS.map((o) => `<option value="${o.value}" ${myDecision && myDecision.decision === o.value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}
          </select>
        </div>
        <div class="field hidden" id="otherTextWrap">
          <label for="otherTextInput">اكتب القرار</label>
          <input type="text" id="otherTextInput" value="${esc(myDecision?.otherText || "")}" ${closed ? "disabled" : ""} />
        </div>
      </div>
      <div class="field">
        <label for="notesInput">ملاحظات (اختياري)</label>
        <textarea id="notesInput" ${closed ? "disabled" : ""}>${esc(myDecision?.notes || "")}</textarea>
      </div>
      <div class="row">
        <button class="btn btn-primary" id="saveDecisionBtn" ${closed ? "disabled" : ""}>${myDecision ? "تحديث القرار" : "حفظ القرار"}</button>
        ${myDecision ? '<span class="decision-saved-tag">✓ تم التسجيل</span>' : ""}
      </div>
    </div>
    <div class="decision-progress">تم البت من قِبل ${decidedCount} من ${memberRosterCache.length || "؟"} أعضاء${closed ? " · هذه اللجنة مغلقة ولا يمكن تعديل القرارات" : ""}</div>
    <div class="roster">
      <div class="text-sm muted" style="margin-bottom:6px;">قرارات الأعضاء</div>
      <div id="memberRoster"></div>
    </div>`;

  renderAttachmentsList($("#memberAttachments"), committee.id, topic.id, { canEdit: false });

  // roster of every member's current status on this topic
  const rosterBox = $("#memberRoster");
  const roster = memberRosterCache.length ? memberRosterCache : Object.values(decisions).map((d) => ({ id: null, name: d.memberName, role: "" }));
  rosterBox.innerHTML = roster.map((m) => {
    const d = m.id ? decisions[m.id] : decisions && Object.values(decisions).find((x) => x.memberName === m.name);
    if (d) {
      const opt = optionByValue(d.decision);
      const label = d.decision === "other" && d.otherText ? d.otherText : (opt ? opt.label : d.decision);
      return `<div class="roster-row"><div class="who"><b>${esc(m.name)}</b>${m.role ? ` <span class="muted">(${esc(ROLE_LABEL[m.role] || "عضو")})</span>` : ""}</div><span class="pill ${opt ? opt.pill : ""}">${esc(label)}</span></div>`;
    }
    return `<div class="roster-row"><div class="who"><b>${esc(m.name)}</b>${m.role ? ` <span class="muted">(${esc(ROLE_LABEL[m.role] || "عضو")})</span>` : ""}</div><span class="pill pill-pending">قيد التصويت</span></div>`;
  }).join("");

  const decisionSelect = $("#decisionSelect");
  const otherWrap = $("#otherTextWrap");
  function syncOtherVisibility() { otherWrap.classList.toggle("hidden", decisionSelect.value !== "other"); }
  syncOtherVisibility();
  decisionSelect.addEventListener("change", syncOtherVisibility);

  const btn = $("#saveDecisionBtn");
  if (btn) {
    btn.addEventListener("click", async () => {
      const val = $("#decisionSelect").value;
      if (!val) return toast("الرجاء اختيار قرار أولًا");
      if (val === "other" && !$("#otherTextInput").value.trim()) return toast("الرجاء كتابة نص القرار");
      btn.disabled = true;
      try {
        await updateDoc(doc(db, "committees", committee.id, "topics", topic.id), {
          [`decisions.${CURRENT.id}`]: {
            decision: val,
            memberName: CURRENT.name,
            username: CURRENT.username,
            decidedAt: new Date().toISOString(),
            notes: $("#notesInput").value.trim(),
            otherText: val === "other" ? $("#otherTextInput").value.trim() : "",
          },
        });
        toast("تم حفظ قرارك بنجاح");
      } catch (e) { toast("تعذر الحفظ: " + e.message); }
      btn.disabled = false;
    });
  }
}

async function openChangePasswordModal() {
  const snap = await getDoc(doc(db, "members", CURRENT.id));
  const m = snap.data();
  const hasPass = !!m.passwordHash;
  openModal({
    title: "تغيير كلمة المرور",
    bodyHTML: `
      <div class="stack">
        ${hasPass ? '<div class="field"><label>كلمة المرور الحالية</label><input type="password" id="curPass"/></div>' : '<div class="text-sm muted">لا توجد كلمة مرور مضبوطة حاليًا، يمكنك تعيين واحدة الآن.</div>'}
        <div class="field"><label>كلمة المرور الجديدة</label><input type="password" id="newPass"/></div>
        <div class="field"><label>تأكيد كلمة المرور الجديدة</label><input type="password" id="newPass2"/></div>
      </div>`,
    foot: (() => {
      const f = document.createDocumentFragment();
      const cancel = el("button", { class: "btn", onclick: closeModal }, "إلغاء");
      const save = el("button", { class: "btn btn-primary" }, "حفظ");
      save.addEventListener("click", async () => {
        if (hasPass) {
          const cur = $("#curPass").value;
          if ((await sha256(cur || "")) !== m.passwordHash) return toast("كلمة المرور الحالية غير صحيحة");
        }
        const p1 = $("#newPass").value, p2 = $("#newPass2").value;
        if (p1.length < 4) return toast("كلمة المرور قصيرة جدًا (٤ أحرف على الأقل)");
        if (p1 !== p2) return toast("كلمتا المرور غير متطابقتين");
        await updateDoc(doc(db, "members", CURRENT.id), { passwordHash: await sha256(p1) });
        toast("تم تحديث كلمة المرور");
        closeModal();
      });
      f.append(cancel, save);
      return f;
    })(),
  });
}

// ================================================================
// ADMIN DASHBOARD
// ================================================================
let adminView = "committees"; // committees | committee-detail | members | report
let adminSelectedCommitteeId = null;

function renderAdminShell() {
  teardown();
  renderAdminSidebar();
  renderAdminMain();
}

function renderAdminSidebar() {
  const sb = $("#sidebar");
  sb.innerHTML = `<div class="nav-label">الإدارة</div>`;
  const items = [
    ["committees", "اللجان والموضوعات"],
    ["members", "الأعضاء"],
    ["report", "التقارير والطباعة"],
  ];
  items.forEach(([key, label]) => {
    const isActive = adminView === key || (key === "committees" && adminView === "committee-detail");
    sb.appendChild(el("button", {
      class: "nav-item" + (isActive ? " active" : ""),
      onclick: () => { adminView = key; renderAdminSidebar(); renderAdminMain(); },
    }, label));
  });
}

function renderAdminMain() {
  teardown();
  const main = $("#mainView");
  if (adminView === "committees") return renderAdminCommittees(main);
  if (adminView === "committee-detail") return renderAdminCommitteeDetail(main, adminSelectedCommitteeId);
  if (adminView === "members") return renderAdminMembers(main);
  if (adminView === "report") return renderAdminReport(main);
}

// ---------- committees list ----------
function renderAdminCommittees(main) {
  main.innerHTML = `
    <div class="main-header">
      <div><h2>اللجان</h2><div class="sub">إنشاء لجان جديدة ومتابعة حالتها</div></div>
      <div class="main-actions"><button class="btn btn-primary" id="newCommitteeBtn">+ إنشاء لجنة جديدة</button></div>
    </div>
    <div class="card"><div class="table-wrap"><table class="data" id="committeesTable">
      <thead><tr><th>اسم/رقم اللجنة</th><th>التاريخ</th><th>الحالة</th><th>عدد الموضوعات</th><th></th></tr></thead>
      <tbody><tr><td colspan="5" class="muted">جارِ التحميل…</td></tr></tbody>
    </table></div></div>`;

  $("#newCommitteeBtn").addEventListener("click", () => openCommitteeModal(null));

  const qAll = query(collection(db, "committees"), orderBy("createdAt", "desc"));
  const unsub = onSnapshot(qAll, async (snap) => {
    const rows = [];
    for (const d of snap.docs) {
      const c = { id: d.id, ...d.data() };
      const topicsSnap = await getDocs(collection(db, "committees", c.id, "topics"));
      rows.push({ ...c, topicsCount: topicsSnap.size });
    }
    const tbody = $("#committeesTable tbody");
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="5" class="muted">لا توجد لجان بعد</td></tr>`; return; }
    tbody.innerHTML = "";
    rows.forEach((c) => {
      const tr = el("tr");
      const statusChip = `<span class="status-chip ${c.status === "مفتوحة" ? "status-active" : "status-closed"}">${esc(c.status)}</span>`;
      tr.innerHTML = `<td>${esc(c.number)}</td><td>${fmtDate(c.date)}</td><td>${statusChip}</td><td>${c.topicsCount}</td>`;
      const tdActions = el("td", { class: "actions-cell" });
      const openBtn = el("button", { class: "btn btn-sm", onclick: () => { adminSelectedCommitteeId = c.id; adminView = "committee-detail"; renderAdminSidebar(); renderAdminMain(); } }, "فتح الموضوعات");
      const editBtn = el("button", { class: "btn btn-sm", style: "margin-inline-start:8px;", onclick: () => openCommitteeModal(c) }, "تعديل");
      const toggleBtn = el("button", {
        class: "btn btn-sm", style: "margin-inline-start:8px;",
        onclick: async () => { await updateDoc(doc(db, "committees", c.id), { status: c.status === "مفتوحة" ? "مغلقة" : "مفتوحة" }); },
      }, c.status === "مفتوحة" ? "إغلاق" : "إعادة فتح");
      tdActions.append(openBtn, editBtn, toggleBtn);
      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    });
  });
  activeUnsubs.push(unsub);
}

function openCommitteeModal(committee) {
  const isEdit = !!committee;
  openModal({
    title: isEdit ? "تعديل بيانات اللجنة" : "إنشاء لجنة جديدة",
    bodyHTML: `
      <div class="field"><label>اسم/رقم اللجنة</label><input type="text" id="cNumber" value="${esc(committee?.number || "")}" placeholder="مثال: اللجنة الدائمة ١٤٤٧/١٢" /></div>
      <div class="field"><label>تاريخ الاجتماع</label><input type="date" id="cDate" value="${esc(committee?.date || "")}" /></div>`,
    foot: (() => {
      const f = document.createDocumentFragment();
      f.append(
        el("button", { class: "btn", onclick: closeModal }, "إلغاء"),
        (() => {
          const b = el("button", { class: "btn btn-primary" }, isEdit ? "حفظ التعديلات" : "إنشاء");
          b.addEventListener("click", async () => {
            const number = $("#cNumber").value.trim();
            const date = $("#cDate").value;
            if (!number) return toast("الرجاء إدخال اسم/رقم اللجنة");
            if (isEdit) {
              await updateDoc(doc(db, "committees", committee.id), { number, date });
              toast("تم حفظ التعديلات");
            } else {
              await addDoc(collection(db, "committees"), { number, date, status: "مفتوحة", createdAt: serverTimestamp() });
              toast("تم إنشاء اللجنة");
            }
            closeModal();
          });
          return b;
        })(),
      );
      return f;
    })(),
  });
}

// ---------- committee detail (topics) ----------
function renderAdminCommitteeDetail(main, committeeId) {
  main.innerHTML = `<div class="card card-pad"><div class="muted">جارِ التحميل…</div></div>`;
  const unsub = onSnapshot(doc(db, "committees", committeeId), (snap) => {
    if (!snap.exists()) { main.innerHTML = `<div class="empty-state">هذه اللجنة غير موجودة</div>`; return; }
    const committee = { id: snap.id, ...snap.data() };
    loadAdminTopics(main, committee);
  });
  activeUnsubs.push(unsub);
}

let memberRosterCacheAdmin = [];
async function loadAdminTopics(main, committee) {
  const membersSnap = await getDocs(collection(db, "members"));
  const allMembers = sortMembersForDisplay(membersSnap.docs.map((d) => ({ id: d.id, ...d.data() }))).filter((m) => m.active !== false);
  memberRosterCacheAdmin = allMembers;
  const totalMembers = allMembers.length;

  const topicsQ = query(collection(db, "committees", committee.id, "topics"), orderBy("order"));
  const unsub = onSnapshot(topicsQ, (snap) => {
    const topics = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAdminTopicsTable(main, committee, topics, totalMembers);
  });
  activeUnsubs.push(unsub);
}

function tallyDecisions(topic) {
  const tally = {};
  DECISION_OPTIONS.forEach((o) => (tally[o.value] = 0));
  Object.values(topic.decisions || {}).forEach((d) => { if (tally[d.decision] !== undefined) tally[d.decision]++; });
  let best = null, bestCount = -1, tie = false;
  Object.entries(tally).forEach(([k, v]) => {
    if (v > bestCount) { best = k; bestCount = v; tie = false; }
    else if (v === bestCount && v > 0) { tie = true; }
  });
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  return { tally, best: total ? best : null, bestCount, tie: total ? tie : false, total };
}

function renderAdminTopicsTable(main, committee, topics, totalMembers) {
  main.innerHTML = `
    <div class="main-header">
      <div>
        <button class="btn btn-ghost btn-sm" id="backToCommittees">‹ رجوع إلى اللجان</button>
        <h2 style="margin-top:6px;">${esc(committee.number)}</h2>
        <div class="sub">${fmtDate(committee.date)} · <span class="status-chip ${committee.status === "مفتوحة" ? "status-active" : "status-closed"}">${esc(committee.status)}</span></div>
      </div>
      <div class="main-actions"><button class="btn btn-primary" id="addTopicBtn">+ إضافة موضوع</button></div>
    </div>
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>الترتيب</th><th>#</th><th>الباحث</th><th>الجهة</th><th>الأصوات</th><th>القرار النهائي</th><th></th></tr></thead>
      <tbody id="topicsTbody"></tbody>
    </table></div></div>`;

  $("#backToCommittees").addEventListener("click", () => { adminView = "committees"; renderAdminSidebar(); renderAdminMain(); });
  $("#addTopicBtn").addEventListener("click", () => openTopicModal(committee, null, topics.length));

  const tbody = $("#topicsTbody");
  if (!topics.length) { tbody.innerHTML = `<tr><td colspan="7" class="muted">لا توجد موضوعات بعد</td></tr>`; return; }

  topics.forEach((t, i) => {
    const { best, bestCount, tie, total } = tallyDecisions(t);
    const finalVal = t.finalDecisionOverride || best;
    const finalOpt = finalVal ? optionByValue(finalVal) : null;
    const tr = el("tr");
    tr.innerHTML = `
      <td></td>
      <td>${i + 1}</td>
      <td>${esc(t.researcherName || "—")}<div class="text-sm muted">الرقم الوظيفي: ${esc(t.fileNumber || "—")}</div></td>
      <td>${esc(t.entity || "—")}</td>
      <td>${total} / ${totalMembers}&nbsp; <button class="btn btn-sm btn-ghost" data-votes="${t.id}">عرض</button></td>
      <td>${finalOpt ? `<span class="pill ${finalOpt.pill}">${esc(finalOpt.label)}</span>` : '<span class="pill pill-pending">قيد التصويت</span>'}${tie ? ' <span class="text-sm">(تعادل)</span>' : ""}</td>
      <td></td>`;
    const tdOrder = tr.firstElementChild;
    tdOrder.style.whiteSpace = "nowrap";
    const upBtn = el("button", { class: "btn btn-sm", title: "تحريك لأعلى" }, "▲");
    const downBtn = el("button", { class: "btn btn-sm", style: "margin-inline-start:6px;", title: "تحريك لأسفل" }, "▼");
    if (i === 0) upBtn.disabled = true;
    if (i === topics.length - 1) downBtn.disabled = true;
    if (i > 0) upBtn.addEventListener("click", () => swapTopicOrder(committee.id, topics, i, i - 1));
    if (i < topics.length - 1) downBtn.addEventListener("click", () => swapTopicOrder(committee.id, topics, i, i + 1));
    tdOrder.append(upBtn, downBtn);
    const tdActions = tr.lastElementChild;
    tdActions.classList.add("actions-cell");
    const editBtn = el("button", { class: "btn btn-sm", onclick: () => openTopicModal(committee, t, i) }, "تعديل");
    const delBtn = el("button", { class: "btn btn-sm btn-danger", style: "margin-inline-start:8px;", onclick: () => confirmDeleteTopic(committee, t) }, "حذف");
    tdActions.append(editBtn, delBtn);
    tbody.appendChild(tr);
    tr.querySelector(`[data-votes]`).addEventListener("click", () => openVotesModal(committee, t));
  });
}

async function swapTopicOrder(committeeId, topics, i, j) {
  const orders = topics.map((t, idx) => idx);
  const tmp = orders[i]; orders[i] = orders[j]; orders[j] = tmp;
  await Promise.all(topics.map((t, idx) => updateDoc(doc(db, "committees", committeeId, "topics", t.id), { order: orders[idx] })));
}

function openVotesModal(committee, topic) {
  const decisions = topic.decisions || {};
  const roster = memberRosterCacheAdmin.length ? memberRosterCacheAdmin : Object.keys(decisions).map((id) => ({ id, name: decisions[id].memberName }));
  const rows = roster.map((m) => {
    const d = decisions[m.id];
    const opt = d ? optionByValue(d.decision) : null;
    const label = d ? (d.decision === "other" && d.otherText ? d.otherText : (opt ? opt.label : d.decision)) : null;
    const pillHtml = d
      ? `<span class="pill ${opt ? opt.pill : ""}">${esc(label)}</span>`
      : `<span class="pill pill-pending">قيد التصويت</span>`;
    const notesHtml = d && d.notes ? `<div class="text-sm muted" style="margin-top:2px;">ملاحظة: ${esc(d.notes)}</div>` : "";
    const resetBtn = d ? `<button class="btn btn-sm btn-danger" data-reset-vote="${m.id}">إعادة لقيد التصويت</button>` : "";
    return `<tr>
      <td>${esc(m.name)}</td>
      <td>${pillHtml}${notesHtml}</td>
      <td>
        <select class="btn btn-sm" data-vote-select="${m.id}" style="margin-inline-end:6px;">
          <option value="">— تغيير —</option>
          ${DECISION_OPTIONS.map((o) => `<option value="${o.value}">${esc(o.label)}</option>`).join("")}
        </select>
        ${resetBtn}
      </td>
    </tr>`;
  }).join("") || `<tr><td colspan="3" class="muted">لا يوجد أعضاء بعد</td></tr>`;
  const { best, tie } = tallyDecisions(topic);
  const bestOpt = best ? optionByValue(best) : null;

  const modal = openModal({
    title: `أصوات الأعضاء — ${topic.researcherName || ""}`,
    bodyHTML: `
      <div class="table-wrap"><table class="data"><thead><tr><th>العضو</th><th>القرار الحالي</th><th>تعديل المسؤول</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="field" style="margin-top:18px;">
        <label>القرار النهائي (يمكن ضبطه يدويًا لحسم الحالات المتعادلة)</label>
        <select id="overrideSelect">
          <option value="">— تلقائي حسب الأغلبية ${bestOpt ? `(${esc(bestOpt.label)})` : ""} ${tie ? " — تعادل حاليًا" : ""} —</option>
          ${DECISION_OPTIONS.map((o) => `<option value="${o.value}" ${topic.finalDecisionOverride === o.value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}
        </select>
      </div>`,
    foot: (() => {
      const f = document.createDocumentFragment();
      f.append(
        el("button", { class: "btn", onclick: closeModal }, "إغلاق"),
        (() => {
          const b = el("button", { class: "btn btn-primary" }, "حفظ القرار النهائي");
          b.addEventListener("click", async () => {
            const v = $("#overrideSelect").value;
            await updateDoc(doc(db, "committees", committee.id, "topics", topic.id), { finalDecisionOverride: v || null });
            toast("تم الحفظ"); closeModal();
          });
          return b;
        })(),
      );
      return f;
    })(),
    onMount: (modalEl) => {
      $all("[data-reset-vote]", modalEl).forEach((btn) => btn.addEventListener("click", async () => {
        const memberId = btn.dataset.resetVote;
        await updateDoc(doc(db, "committees", committee.id, "topics", topic.id), { [`decisions.${memberId}`]: deleteField() });
        toast("تمت إعادة العضو لحالة قيد التصويت");
        closeModal();
        openVotesModal(committee, { ...topic, decisions: Object.fromEntries(Object.entries(decisions).filter(([k]) => k !== memberId)) });
      }));
      $all("[data-vote-select]", modalEl).forEach((sel) => sel.addEventListener("change", async () => {
        const memberId = sel.dataset.voteSelect;
        const val = sel.value;
        if (!val) return;
        const member = roster.find((m) => m.id === memberId);
        await updateDoc(doc(db, "committees", committee.id, "topics", topic.id), {
          [`decisions.${memberId}`]: {
            decision: val, memberName: member ? member.name : (decisions[memberId]?.memberName || ""),
            username: member ? member.username : (decisions[memberId]?.username || ""),
            decidedAt: new Date().toISOString(),
            notes: decisions[memberId]?.notes || "",
            otherText: val === "other" ? (prompt("اكتب نص القرار:") || "") : "",
            setByAdmin: true,
          },
        });
        toast("تم تعديل القرار بواسطة المسؤول");
        closeModal();
      }));
    },
  });
}

function confirmDeleteTopic(committee, topic) {
  openModal({
    title: "تأكيد الحذف",
    bodyHTML: `<p>هل أنت متأكد من حذف موضوع "<b>${esc(topic.researcherName || topic.fileNumber || "")}</b>"؟ لا يمكن التراجع عن هذا الإجراء.</p>`,
    foot: (() => {
      const f = document.createDocumentFragment();
      f.append(
        el("button", { class: "btn", onclick: closeModal }, "إلغاء"),
        (() => {
          const b = el("button", { class: "btn btn-danger" }, "حذف نهائيًا");
          b.addEventListener("click", async () => {
            await deleteDoc(doc(db, "committees", committee.id, "topics", topic.id));
            toast("تم الحذف"); closeModal();
          });
          return b;
        })(),
      );
      return f;
    })(),
  });
}

function openTopicModal(committee, topic, orderIndex) {
  const t = topic || {};
  const existingHijri = t.contractEndDate ? gregorianToHijriParts(new Date(t.contractEndDate + "T00:00:00Z")) : null;
  openModal({
    title: topic ? "تعديل الموضوع" : "إضافة موضوع جديد",
    bodyHTML: `
      <div class="form-grid">
        <div class="field full"><label>اسم الباحث</label><input type="text" id="fName" value="${esc(t.researcherName || "")}" /></div>
        <div class="field"><label>الرقم الوظيفي</label><input type="text" id="fFile" value="${esc(t.fileNumber || "")}" /></div>
        <div class="field"><label>اسم المشرف</label><input type="text" id="fSupervisor" value="${esc(t.supervisorName || "")}" /></div>
        <div class="field"><label>المؤهل</label><input type="text" id="fQualification" value="${esc(t.qualification || "")}" /></div>
        <div class="field"><label>التخصص</label><input type="text" id="fSpecialization" value="${esc(t.specialization || "")}" /></div>
        <div class="field"><label>السن</label><input type="number" min="0" id="fAge" value="${t.age ?? ""}" /></div>
        <div class="field full">
          <label>تاريخ نهاية العقد</label>
          <div class="calendar-toggle">
            <label><input type="radio" name="calMode" value="hijri" checked /> هجري</label>
            <label><input type="radio" name="calMode" value="gregorian" /> ميلادي</label>
          </div>
          <div id="hijriDateWrap" class="hijri-date-row">
            <input type="number" id="fHijriDay" min="1" max="30" placeholder="يوم" value="${existingHijri ? existingHijri.day : ""}" />
            <select id="fHijriMonth">${HIJRI_MONTHS.map((mn, i) => `<option value="${i + 1}" ${existingHijri && existingHijri.month === i + 1 ? "selected" : ""}>${mn}</option>`).join("")}</select>
            <input type="number" id="fHijriYear" min="1300" max="1500" placeholder="سنة" value="${existingHijri ? existingHijri.year : ""}" />
          </div>
          <div id="gregorianDateWrap" class="hidden">
            <input type="date" id="fEndDateGregorian" value="${esc(t.contractEndDate || "")}" />
          </div>
          <div class="hint" id="dateConversionHint">${t.contractEndDate ? esc(fmtDateBoth(t.contractEndDate)) : "أدخل التاريخ لعرض المقابل بالتقويمين"}</div>
        </div>
        <div class="field full"><label>الجهة التي يعمل بها</label><input type="text" id="fEntity" value="${esc(t.entity || "")}" /></div>
        <div class="field full"><label>نبذة عن طبيعة العمل والمهام المسندة إليه</label><textarea id="fDesc">${esc(t.jobDescription || "")}</textarea></div>
        <div class="field full"><label>قرار اللجنة السابق حياله</label><input type="text" id="fPrev" value="${esc(t.previousDecision || "")}" /></div>
        <div class="field"><label>العدد الإجمالي للباحثين بنفس الجهة</label><input type="number" min="0" id="fColleagues" value="${t.colleaguesCount ?? ""}" /></div>
        <div class="field full">
          <label>المرفقات</label>
          ${topic ? `
            <div id="attachmentsList"></div>
            <div class="row" style="margin-top:8px;">
              <input type="file" id="attachmentInput" multiple style="flex:1;" />
              <button type="button" class="btn btn-sm" id="uploadAttachmentBtn">رفع</button>
            </div>
            <div class="hint">حجم أقصى تقريبي ٧٠٠ كيلوبايت لكل ملف (مناسب لصور أو مستندات قصيرة بصيغة PDF)</div>
          ` : `<div class="hint">يمكنك إضافة المرفقات بعد حفظ الموضوع، بالضغط على زر "تعديل" أمامه.</div>`}
        </div>
      </div>`,
    foot: (() => {
      const f = document.createDocumentFragment();
      f.append(
        el("button", { class: "btn", onclick: closeModal }, "إلغاء"),
        (() => {
          const b = el("button", { class: "btn btn-primary" }, topic ? "حفظ التعديلات" : "إضافة الموضوع");
          b.addEventListener("click", async () => {
            const calMode = document.querySelector('input[name="calMode"]:checked').value;
            let contractEndDate = "";
            if (calMode === "gregorian") {
              contractEndDate = $("#fEndDateGregorian").value;
            } else {
              const hd = Number($("#fHijriDay").value), hm = Number($("#fHijriMonth").value), hy = Number($("#fHijriYear").value);
              if (hd && hm && hy) contractEndDate = isoFromDateUTC(hijriToGregorian(hy, hm, hd));
            }
            const payload = {
              researcherName: $("#fName").value.trim(),
              fileNumber: $("#fFile").value.trim(),
              supervisorName: $("#fSupervisor").value.trim(),
              qualification: $("#fQualification").value.trim(),
              specialization: $("#fSpecialization").value.trim(),
              age: $("#fAge").value === "" ? null : Number($("#fAge").value),
              contractEndDate,
              entity: $("#fEntity").value.trim(),
              jobDescription: $("#fDesc").value.trim(),
              previousDecision: $("#fPrev").value.trim(),
              colleaguesCount: $("#fColleagues").value === "" ? null : Number($("#fColleagues").value),
            };
            if (topic) {
              await updateDoc(doc(db, "committees", committee.id, "topics", topic.id), payload);
            } else {
              await addDoc(collection(db, "committees", committee.id, "topics"), { ...payload, order: orderIndex, decisions: {}, createdAt: serverTimestamp() });
            }
            toast("تم الحفظ"); closeModal();
          });
          return b;
        })(),
      );
      return f;
    })(),
    onMount: () => {
      // calendar mode toggle + live Hijri/Gregorian conversion preview
      const hijriWrap = $("#hijriDateWrap");
      const gregWrap = $("#gregorianDateWrap");
      const hint = $("#dateConversionHint");
      function updateDatePreview() {
        const mode = document.querySelector('input[name="calMode"]:checked').value;
        if (mode === "gregorian") {
          const v = $("#fEndDateGregorian").value;
          hint.textContent = v ? fmtDateBoth(v) : "أدخل التاريخ لعرض المقابل بالتقويمين";
        } else {
          const hd = Number($("#fHijriDay").value), hm = Number($("#fHijriMonth").value), hy = Number($("#fHijriYear").value);
          if (hd && hm && hy) {
            const g = hijriToGregorian(hy, hm, hd);
            hint.textContent = fmtDateBoth(isoFromDateUTC(g));
          } else {
            hint.textContent = "أدخل اليوم والشهر والسنة الهجرية لعرض المقابل الميلادي";
          }
        }
      }
      $all('input[name="calMode"]').forEach((r) => r.addEventListener("change", () => {
        const mode = r.value;
        hijriWrap.classList.toggle("hidden", mode !== "hijri");
        gregWrap.classList.toggle("hidden", mode !== "gregorian");
        updateDatePreview();
      }));
      ["fHijriDay", "fHijriMonth", "fHijriYear"].forEach((id) => $("#" + id).addEventListener("input", updateDatePreview));
      $("#fEndDateGregorian").addEventListener("input", updateDatePreview);
      // if editing a topic that already has a date, default to whichever
      // calendar has a usable value pre-filled
      if (t.contractEndDate) {
        document.querySelector('input[name="calMode"][value="hijri"]').checked = true;
        hijriWrap.classList.remove("hidden");
        gregWrap.classList.add("hidden");
      }

      if (!topic) return;
      const listBox = $("#attachmentsList");
      renderAttachmentsList(listBox, committee.id, topic.id, { canEdit: true });
      $("#uploadAttachmentBtn").addEventListener("click", async () => {
        const input = $("#attachmentInput");
        if (!input.files.length) return toast("اختر ملفًا أولًا");
        await uploadAttachments(committee.id, topic.id, input.files);
        input.value = "";
        renderAttachmentsList(listBox, committee.id, topic.id, { canEdit: true });
      });
    },
  });
}

// ---------- attachments (stored as base64 documents in a sub-collection) ----------
const MAX_ATTACHMENT_BYTES = 700 * 1024; // keep comfortably under Firestore's 1MiB per-document cap

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("تعذرت قراءة الملف"));
    reader.readAsDataURL(file);
  });
}

async function uploadAttachments(committeeId, topicId, fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast(`الملف "${file.name}" أكبر من الحد المسموح (٧٠٠ ك.ب تقريبًا) ولم يُرفع`);
      continue;
    }
    try {
      const dataUrl = await readFileAsDataURL(file);
      await addDoc(collection(db, "committees", committeeId, "topics", topicId, "attachments"), {
        name: file.name, type: file.type || "", size: file.size, dataUrl, uploadedAt: new Date().toISOString(),
      });
    } catch (e) {
      toast(`تعذر رفع "${file.name}": ${e.message}`);
    }
  }
  toast("تم تحديث المرفقات");
}

async function renderAttachmentsList(container, committeeId, topicId, { canEdit }) {
  container.innerHTML = `<div class="text-sm muted">جارِ تحميل المرفقات…</div>`;
  const snap = await getDocs(collection(db, "committees", committeeId, "topics", topicId, "attachments"));
  if (snap.empty) {
    container.innerHTML = `<div class="text-sm muted">لا توجد مرفقات لهذا الموضوع</div>`;
    return;
  }
  container.innerHTML = "";
  snap.forEach((docSnap) => {
    const a = docSnap.data();
    const row = el("div", { class: "row", style: "padding:6px 2px; border-bottom:1px solid var(--border);" });
    row.innerHTML = `
      <a href="${a.dataUrl}" download="${esc(a.name)}" class="text-sm" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">📎 ${esc(a.name)}</a>
      <span class="text-sm muted">${Math.round((a.size || 0) / 1024)} ك.ب</span>`;
    if (canEdit) {
      const delBtn = el("button", {
        class: "icon-btn", title: "حذف المرفق",
        onclick: async () => {
          await deleteDoc(doc(db, "committees", committeeId, "topics", topicId, "attachments", docSnap.id));
          renderAttachmentsList(container, committeeId, topicId, { canEdit });
        },
      }, "✕");
      row.appendChild(delBtn);
    }
    container.appendChild(row);
  });
}

// ---------- members management ----------
function renderAdminMembers(main) {
  main.innerHTML = `
    <div class="main-header">
      <div><h2>الأعضاء</h2><div class="sub">رئيس اللجنة والأعضاء — الترتيب هنا هو نفس ترتيب ظهور الأسماء عند تسجيل الدخول</div></div>
      <div class="main-actions"><button class="btn btn-primary" id="addMemberBtn">+ إضافة عضو</button></div>
    </div>
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>الترتيب</th><th>الاسم</th><th>البريد الجامعي (اسم المستخدم)</th><th>الصفة</th><th>كلمة المرور</th><th></th></tr></thead>
      <tbody id="membersTbody"><tr><td colspan="6" class="muted">جارِ التحميل…</td></tr></tbody>
    </table></div></div>`;

  $("#addMemberBtn").addEventListener("click", () => openMemberModal(null));

  const unsub = onSnapshot(collection(db, "members"), (snap) => {
    const tbody = $("#membersTbody");
    if (snap.empty) { tbody.innerHTML = `<tr><td colspan="6" class="muted">لا يوجد أعضاء بعد</td></tr>`; return; }
    const members = sortMembersForDisplay(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    tbody.innerHTML = "";
    members.forEach((m, i) => {
      const tr = el("tr");
      tr.innerHTML = `<td></td>
        <td>${esc(m.name)}${m.active === false ? ' <span class="text-sm muted">(معطّل)</span>' : ""}</td>
        <td>${esc(m.username)}</td><td>${esc(ROLE_LABEL[m.role] || "عضو")}</td>
        <td class="text-sm muted">${m.passwordHash ? "مُفعّلة" : "بدون كلمة مرور"}</td><td></td>`;
      const tdOrder = tr.firstElementChild;
      tdOrder.style.whiteSpace = "nowrap";
      const upBtn = el("button", { class: "btn btn-sm", title: "تحريك لأعلى" }, "▲");
      const downBtn = el("button", { class: "btn btn-sm", style: "margin-inline-start:6px;", title: "تحريك لأسفل" }, "▼");
      if (i === 0) upBtn.disabled = true;
      if (i === members.length - 1) downBtn.disabled = true;
      if (i > 0) upBtn.addEventListener("click", () => swapMemberOrder(members, i, i - 1));
      if (i < members.length - 1) downBtn.addEventListener("click", () => swapMemberOrder(members, i, i + 1));
      tdOrder.append(upBtn, downBtn);
      const tdActions = tr.lastElementChild;
    tdActions.classList.add("actions-cell");
      tdActions.append(
        el("button", { class: "btn btn-sm", onclick: () => openMemberModal(m) }, "تعديل"),
        el("button", { class: "btn btn-sm btn-danger", style: "margin-inline-start:8px;", onclick: () => confirmDeleteMember(m) }, "حذف"),
      );
      tbody.appendChild(tr);
    });
  });
  activeUnsubs.push(unsub);
}

async function swapMemberOrder(sortedMembers, i, j) {
  // materialize the full current order first (covers members that never had an
  // explicit "order" field yet), then swap the two positions requested.
  const orders = sortedMembers.map((m, idx) => idx);
  const tmp = orders[i]; orders[i] = orders[j]; orders[j] = tmp;
  await Promise.all(sortedMembers.map((m, idx) => updateDoc(doc(db, "members", m.id), { order: orders[idx] })));
}

function openMemberModal(member) {
  const m = member || {};
  openModal({
    title: member ? "تعديل بيانات العضو" : "إضافة عضو جديد",
    bodyHTML: `
      <div class="field"><label>الاسم الكامل</label><input type="text" id="mName" value="${esc(m.name || "")}" /></div>
      <div class="field"><label>البريد الجامعي (يُستخدم كاسم مستخدم)</label><input type="text" id="mUsername" value="${esc(m.username || "")}" placeholder="name@ksu.edu.sa" /></div>
      <div class="field"><label>الصفة</label><select id="mRole">
        <option value="member" ${!m.role || m.role === "member" ? "selected" : ""}>عضو</option>
        <option value="secretary" ${m.role === "secretary" ? "selected" : ""}>أمين اللجنة</option>
        <option value="chair" ${m.role === "chair" ? "selected" : ""}>رئيس اللجنة</option>
      </select></div>
      ${!member ? '<div class="field"><label>كلمة مرور مبدئية (اختياري)</label><input type="password" id="mPassword" placeholder="يمكن تركها فارغة والدخول بالاسم فقط" /></div>' : `<div class="field"><label>${m.passwordHash ? "تغيير كلمة المرور" : "تعيين كلمة مرور"}</label><input type="password" id="mPassword" placeholder="اتركها فارغة إن لم ترغب بأي تغيير" /></div>`}
      ${member ? '<div class="field"><label>الحالة</label><select id="mActive"><option value="true" ' + (m.active !== false ? "selected" : "") + '>مفعّل</option><option value="false" ' + (m.active === false ? "selected" : "") + '>معطّل</option></select></div>' : ""}
      ${member && m.passwordHash ? '<button class="btn btn-sm btn-danger" id="resetPassBtn" type="button">إزالة كلمة المرور (السماح بالدخول بالاسم فقط)</button>' : ""}
    `,
    foot: (() => {
      const f = document.createDocumentFragment();
      f.append(
        el("button", { class: "btn", onclick: closeModal }, "إلغاء"),
        (() => {
          const b = el("button", { class: "btn btn-primary" }, member ? "حفظ" : "إضافة");
          b.addEventListener("click", async () => {
            const name = $("#mName").value.trim();
            const username = $("#mUsername").value.trim();
            const role = $("#mRole").value;
            if (!name || !username) return toast("الرجاء تعبئة الاسم والبريد الجامعي");
            if (member) {
              const payload = { name, username, role, active: $("#mActive").value === "true" };
              const passEl = $("#mPassword");
              if (passEl && passEl.value) payload.passwordHash = await sha256(passEl.value);
              await updateDoc(doc(db, "members", member.id), payload);
            } else {
              const passEl = $("#mPassword");
              const payload = { name, username, role, active: true, passwordHash: null };
              if (passEl && passEl.value) payload.passwordHash = await sha256(passEl.value);
              await addDoc(collection(db, "members"), payload);
            }
            toast("تم الحفظ");
            closeModal();
            populateMemberList();
          });
          return b;
        })(),
      );
      return f;
    })(),
    onMount: () => {
      const rb = $("#resetPassBtn");
      if (rb) rb.addEventListener("click", async () => {
        await updateDoc(doc(db, "members", member.id), { passwordHash: null });
        toast("تمت إزالة كلمة المرور"); closeModal();
      });
    },
  });
}

function confirmDeleteMember(member) {
  openModal({
    title: "تأكيد الحذف",
    bodyHTML: `<p>هل تريد حذف العضو "<b>${esc(member.name)}</b>"؟ لن يُحذف هذا تصويتاته السابقة المسجّلة ضمن الموضوعات.</p>`,
    foot: (() => {
      const f = document.createDocumentFragment();
      f.append(
        el("button", { class: "btn", onclick: closeModal }, "إلغاء"),
        (() => {
          const b = el("button", { class: "btn btn-danger" }, "حذف");
          b.addEventListener("click", async () => { await deleteDoc(doc(db, "members", member.id)); toast("تم الحذف"); closeModal(); populateMemberList(); });
          return b;
        })(),
      );
      return f;
    })(),
  });
}

// ---------- reports / printing ----------
function renderAdminReport(main) {
  main.innerHTML = `
    <div class="main-header"><div><h2>التقارير والطباعة</h2><div class="sub">اختر لجنة لعرض ملخص قراراتها وطباعته</div></div></div>
    <div class="card card-pad">
      <div class="field"><label>اللجنة</label><select id="reportCommitteeSelect"><option value="">اختر لجنة…</option></select></div>
      <div id="reportPreview"></div>
    </div>`;

  getDocs(query(collection(db, "committees"), orderBy("createdAt", "desc"))).then((snap) => {
    const sel = $("#reportCommitteeSelect");
    snap.forEach((d) => sel.appendChild(el("option", { value: d.id }, `${esc(d.data().number)} — ${fmtDate(d.data().date)}`)));
    sel.addEventListener("change", () => sel.value && buildReport(sel.value));
  });
}

async function buildReport(committeeId) {
  const cSnap = await getDoc(doc(db, "committees", committeeId));
  const committee = { id: cSnap.id, ...cSnap.data() };
  const topicsSnap = await getDocs(query(collection(db, "committees", committeeId, "topics"), orderBy("order")));
  const topics = topicsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const rows = topics.map((t, i) => {
    const { best, tie, total } = tallyDecisions(t);
    const finalVal = t.finalDecisionOverride || best;
    const finalOpt = finalVal ? optionByValue(finalVal) : null;
    return `<tr>
      <td>${i + 1}</td>
      <td>${esc(t.researcherName || "—")}</td>
      <td>${esc(t.fileNumber || "—")}</td>
      <td>${esc(t.entity || "—")}</td>
      <td>${finalOpt ? esc(finalOpt.label) : "بدون قرار نهائي"}${tie ? " (تعادل)" : ""}</td>
      <td>${total}</td>
    </tr>`;
  }).join("");

  const html = `
    <div class="report-head">
      <img src="ksu-logo.png" alt="شعار جامعة الملك سعود" style="height:56px; margin-bottom:10px;" />
      <h1>ملخص قرارات اللجنة الدائمة لتنفيذ آلية التجديد للمتعاقدين</h1>
      <div class="meta">${esc(committee.number)} — ${fmtDate(committee.date)} — الحالة: ${esc(committee.status)}</div>
      <div class="meta">على برنامج الاستقطاب</div>
    </div>
    <table class="report-table">
      <thead><tr><th>#</th><th>اسم الباحث</th><th>الرقم الوظيفي</th><th>الجهة</th><th>القرار النهائي</th><th>عدد الأصوات</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6">لا توجد موضوعات</td></tr>'}</tbody>
    </table>
    <div class="report-signoff">
      <div>توقيع رئيس اللجنة: ______________________</div>
      <div>التاريخ: ______________________</div>
    </div>`;

  $("#reportPreview").innerHTML = `<div class="card card-pad" style="margin-top:18px;">${html}
    <div style="margin-top:16px;"><button class="btn btn-primary" id="printBtn">طباعة الملخص</button></div></div>`;
  $("#printReport").innerHTML = html;
  $("#printBtn").addEventListener("click", () => window.print());
}
