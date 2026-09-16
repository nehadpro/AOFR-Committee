// ================================================================
// اللجنة الدائمة لتنفيذ آلية التجديد — منطق التطبيق
// ================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, updateDoc,
  deleteDoc, addDoc, onSnapshot, query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const fbApp = initializeApp(window.FIREBASE_CONFIG);
const db = getFirestore(fbApp);

// ---------------- constants ----------------
const DECISION_OPTIONS = [
  { value: "approve", label: "الموافقة", pill: "pill-approve" },
  { value: "reject", label: "عدم الموافقة", pill: "pill-reject" },
  { value: "extend", label: "الموافقة لسنة أخيرة", pill: "pill-extend" },
  { value: "extend_align", label: "الموافقة لسنة أخيرة والمواءمة مع لجنة تخطيط الموارد البشرية", pill: "pill-extend-align" },
];
const optionByValue = (v) => DECISION_OPTIONS.find((o) => o.value === v);

const ROLE_LABEL = { chair: "رئيس اللجنة", member: "عضو" };

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

async function populateMemberList() {
  memberSelect.innerHTML = '<option value="" disabled selected>اختر اسمك من القائمة…</option>';
  const snap = await getDocs(query(collection(db, "members"), orderBy("name")));
  snap.forEach((d) => {
    const m = d.data();
    if (m.active === false) return;
    memberSelect.appendChild(el("option", { value: d.id }, `${esc(m.name)} — ${esc(ROLE_LABEL[m.role] || "عضو")}`));
  });
}

memberSelect.addEventListener("change", async () => {
  const id = memberSelect.value;
  if (!id) return;
  const snap = await getDoc(doc(db, "members", id));
  const m = snap.data();
  $("#memberPasswordField").style.display = m && m.passwordHash ? "flex" : "none";
});

$("#memberLoginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideLoginError();
  const id = memberSelect.value;
  if (!id) return showLoginError("الرجاء اختيار اسمك أولًا");
  const snap = await getDoc(doc(db, "members", id));
  if (!snap.exists()) return showLoginError("تعذر العثور على هذا العضو");
  const m = snap.data();
  if (m.passwordHash) {
    const pass = $("#memberPassword").value;
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
  populateMemberList();
});

// ================================================================
// APP ENTRY
// ================================================================
function enterApp() {
  loginScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  $("#whoName").textContent = CURRENT.type === "admin" ? "المسؤول" : `${CURRENT.name} (${ROLE_LABEL[CURRENT.role] || "عضو"})`;
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
function renderMemberShell() {
  teardown();
  $("#sidebar").innerHTML = `<div class="nav-label">اللجنة الحالية</div>`;
  const main = $("#mainView");
  main.innerHTML = `<div id="memberRoot"></div>`;

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
  const decidedCount = topic.decisions ? Object.keys(topic.decisions).length : 0;
  const closed = committee.status !== "مفتوحة";

  box.innerHTML = `
    <div class="dossier-head">
      <div class="file-no">الموضوع رقم ${indexNum} — ${esc(topic.researcherName || "بدون اسم")}</div>
      <span class="badge">ملف رقم ${esc(topic.fileNumber || "—")}</span>
    </div>
    <div class="dossier-grid">
      <div class="dossier-field"><div class="k">الجهة التي يعمل بها</div><div class="v">${esc(topic.entity || "—")}</div></div>
      <div class="dossier-field"><div class="k">تاريخ نهاية العقد</div><div class="v">${fmtDate(topic.contractEndDate)}</div></div>
      <div class="dossier-field full"><div class="k">نبذة عن طبيعة العمل والمهام المسندة إليه</div><div class="v">${esc(topic.jobDescription || "—")}</div></div>
      <div class="dossier-field"><div class="k">قرار اللجنة السابق حياله</div><div class="v muted">${esc(topic.previousDecision || "لا يوجد")}</div></div>
      <div class="dossier-field"><div class="k">عدد الباحثين معه بنفس الجهة</div><div class="v">${esc(topic.colleaguesCount ?? "—")}</div></div>
      <div class="dossier-field full"><div class="k">المرفقات</div><div id="memberAttachments" class="v"><span class="text-sm muted">جارِ التحميل…</span></div></div>
    </div>
    <div class="decision-panel">
      <div class="field">
        <label for="decisionSelect">قرارك بخصوص هذا الموضوع</label>
        <select id="decisionSelect" ${closed ? "disabled" : ""}>
          <option value="" disabled ${!myDecision ? "selected" : ""}>اختر القرار…</option>
          ${DECISION_OPTIONS.map((o) => `<option value="${o.value}" ${myDecision && myDecision.decision === o.value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}
        </select>
      </div>
      <button class="btn btn-primary" id="saveDecisionBtn" ${closed ? "disabled" : ""}>${myDecision ? "تحديث القرار" : "حفظ القرار"}</button>
      ${myDecision ? '<span class="decision-saved-tag">✓ تم التسجيل</span>' : ""}
    </div>
    <div class="decision-progress">تم البت من قِبل ${decidedCount} عضوًا حتى الآن${closed ? " · هذه اللجنة مغلقة ولا يمكن تعديل القرارات" : ""}</div>`;

  renderAttachmentsList($("#memberAttachments"), committee.id, topic.id, { canEdit: false });

  const btn = $("#saveDecisionBtn");
  if (btn) {
    btn.addEventListener("click", async () => {
      const val = $("#decisionSelect").value;
      if (!val) return toast("الرجاء اختيار قرار أولًا");
      btn.disabled = true;
      try {
        await updateDoc(doc(db, "committees", committee.id, "topics", topic.id), {
          [`decisions.${CURRENT.id}`]: { decision: val, memberName: CURRENT.name, username: CURRENT.username, decidedAt: new Date().toISOString() },
        });
        toast("تم حفظ قرارك بنجاح");
      } catch (e) { toast("تعذر الحفظ: " + e.message); }
      btn.disabled = false;
    });
  }

  // change password (self service)
  if (!$("#memberProfileBar")) {
    const bar = el("div", { id: "memberProfileBar", class: "text-sm", style: "margin-top:14px; text-align:left;" });
    bar.innerHTML = `<button class="btn btn-ghost btn-sm" id="changePassBtn">تغيير كلمة المرور</button>`;
    box.after(bar);
  }
  const cp = $("#changePassBtn");
  if (cp) cp.onclick = openChangePasswordModal;
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
      const tdActions = el("td");
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

async function loadAdminTopics(main, committee) {
  const membersSnap = await getDocs(collection(db, "members"));
  const totalMembers = membersSnap.docs.filter((d) => d.data().active !== false).length;

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
      <thead><tr><th>#</th><th>الباحث</th><th>الجهة</th><th>الأصوات</th><th>القرار النهائي</th><th></th></tr></thead>
      <tbody id="topicsTbody"></tbody>
    </table></div></div>`;

  $("#backToCommittees").addEventListener("click", () => { adminView = "committees"; renderAdminSidebar(); renderAdminMain(); });
  $("#addTopicBtn").addEventListener("click", () => openTopicModal(committee, null, topics.length));

  const tbody = $("#topicsTbody");
  if (!topics.length) { tbody.innerHTML = `<tr><td colspan="6" class="muted">لا توجد موضوعات بعد</td></tr>`; return; }

  topics.forEach((t, i) => {
    const { best, bestCount, tie, total } = tallyDecisions(t);
    const finalVal = t.finalDecisionOverride || best;
    const finalOpt = finalVal ? optionByValue(finalVal) : null;
    const tr = el("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${esc(t.researcherName || "—")}<div class="text-sm muted">ملف ${esc(t.fileNumber || "—")}</div></td>
      <td>${esc(t.entity || "—")}</td>
      <td>${total} / ${totalMembers}&nbsp; <button class="btn btn-sm btn-ghost" data-votes="${t.id}">عرض</button></td>
      <td>${finalOpt ? `<span class="pill ${finalOpt.pill}">${esc(finalOpt.label)}</span>` : '<span class="pill pill-pending">قيد التصويت</span>'}${tie ? ' <span class="text-sm">(تعادل)</span>' : ""}</td>
      <td></td>`;
    const tdActions = tr.lastElementChild;
    const editBtn = el("button", { class: "btn btn-sm", onclick: () => openTopicModal(committee, t, i) }, "تعديل");
    const delBtn = el("button", { class: "btn btn-sm btn-danger", style: "margin-inline-start:8px;", onclick: () => confirmDeleteTopic(committee, t) }, "حذف");
    tdActions.append(editBtn, delBtn);
    tbody.appendChild(tr);
    tr.querySelector(`[data-votes]`).addEventListener("click", () => openVotesModal(committee, t));
  });
}

function openVotesModal(committee, topic) {
  const decisions = topic.decisions || {};
  const rows = Object.values(decisions).map((d) => {
    const opt = optionByValue(d.decision);
    return `<tr><td>${esc(d.memberName)}</td><td><span class="pill ${opt ? opt.pill : ""}">${esc(opt ? opt.label : d.decision)}</span></td></tr>`;
  }).join("") || `<tr><td colspan="2" class="muted">لا توجد أصوات بعد</td></tr>`;
  const { best, tie } = tallyDecisions(topic);
  const bestOpt = best ? optionByValue(best) : null;

  openModal({
    title: `أصوات الأعضاء — ${topic.researcherName || ""}`,
    bodyHTML: `
      <table class="data"><thead><tr><th>العضو</th><th>القرار</th></tr></thead><tbody>${rows}</tbody></table>
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
  openModal({
    title: topic ? "تعديل الموضوع" : "إضافة موضوع جديد",
    bodyHTML: `
      <div class="form-grid">
        <div class="field full"><label>اسم الباحث</label><input type="text" id="fName" value="${esc(t.researcherName || "")}" /></div>
        <div class="field"><label>رقم ملف الموظف</label><input type="text" id="fFile" value="${esc(t.fileNumber || "")}" /></div>
        <div class="field"><label>تاريخ نهاية العقد</label><input type="date" id="fEndDate" value="${esc(t.contractEndDate || "")}" /></div>
        <div class="field full"><label>الجهة التي يعمل بها</label><input type="text" id="fEntity" value="${esc(t.entity || "")}" /></div>
        <div class="field full"><label>نبذة عن طبيعة العمل والمهام المسندة إليه</label><textarea id="fDesc">${esc(t.jobDescription || "")}</textarea></div>
        <div class="field full"><label>قرار اللجنة السابق حياله</label><input type="text" id="fPrev" value="${esc(t.previousDecision || "")}" /></div>
        <div class="field"><label>عدد الباحثين معه بنفس الجهة</label><input type="number" min="0" id="fColleagues" value="${t.colleaguesCount ?? ""}" /></div>
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
            const payload = {
              researcherName: $("#fName").value.trim(),
              fileNumber: $("#fFile").value.trim(),
              contractEndDate: $("#fEndDate").value,
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
      <div><h2>الأعضاء</h2><div class="sub">رئيس اللجنة والأعضاء المصوّتون</div></div>
      <div class="main-actions"><button class="btn btn-primary" id="addMemberBtn">+ إضافة عضو</button></div>
    </div>
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>الاسم</th><th>البريد الجامعي (اسم المستخدم)</th><th>الصفة</th><th>كلمة المرور</th><th></th></tr></thead>
      <tbody id="membersTbody"><tr><td colspan="5" class="muted">جارِ التحميل…</td></tr></tbody>
    </table></div></div>`;

  $("#addMemberBtn").addEventListener("click", () => openMemberModal(null));

  const unsub = onSnapshot(query(collection(db, "members"), orderBy("name")), (snap) => {
    const tbody = $("#membersTbody");
    if (snap.empty) { tbody.innerHTML = `<tr><td colspan="5" class="muted">لا يوجد أعضاء بعد</td></tr>`; return; }
    tbody.innerHTML = "";
    snap.forEach((d) => {
      const m = { id: d.id, ...d.data() };
      const tr = el("tr");
      tr.innerHTML = `<td>${esc(m.name)}${m.active === false ? ' <span class="text-sm muted">(معطّل)</span>' : ""}</td>
        <td>${esc(m.username)}</td><td>${esc(ROLE_LABEL[m.role] || "عضو")}</td>
        <td class="text-sm muted">${m.passwordHash ? "مُفعّلة" : "بدون كلمة مرور"}</td><td></td>`;
      const tdActions = tr.lastElementChild;
      tdActions.append(
        el("button", { class: "btn btn-sm", onclick: () => openMemberModal(m) }, "تعديل"),
        el("button", { class: "btn btn-sm btn-danger", style: "margin-inline-start:8px;", onclick: () => confirmDeleteMember(m) }, "حذف"),
      );
      tbody.appendChild(tr);
    });
  });
  activeUnsubs.push(unsub);
}

function openMemberModal(member) {
  const m = member || {};
  openModal({
    title: member ? "تعديل بيانات العضو" : "إضافة عضو جديد",
    bodyHTML: `
      <div class="field"><label>الاسم الكامل</label><input type="text" id="mName" value="${esc(m.name || "")}" /></div>
      <div class="field"><label>البريد الجامعي (يُستخدم كاسم مستخدم)</label><input type="text" id="mUsername" value="${esc(m.username || "")}" placeholder="name@ksu.edu.sa" /></div>
      <div class="field"><label>الصفة</label><select id="mRole"><option value="member" ${m.role !== "chair" ? "selected" : ""}>عضو</option><option value="chair" ${m.role === "chair" ? "selected" : ""}>رئيس اللجنة</option></select></div>
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
      <h1>ملخص قرارات اللجنة الدائمة لتنفيذ آلية التجديد</h1>
      <div class="meta">${esc(committee.number)} — ${fmtDate(committee.date)} — الحالة: ${esc(committee.status)}</div>
      <div class="meta">برنامج الاستقطاب</div>
    </div>
    <table class="report-table">
      <thead><tr><th>#</th><th>اسم الباحث</th><th>رقم الملف</th><th>الجهة</th><th>القرار النهائي</th><th>عدد الأصوات</th></tr></thead>
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
