/* =========================================================
   Artable 미술 갤러리 — 로직
   - Firebase Firestore 실시간 로드 (onSnapshot)
   - 학급 필터 / 학생 검색 / 날짜 정렬
   - 썸네일 → 큰 이미지 모달 (다운로드/공유)
   - 관리자 모드 (숨김/삭제)
   - Firebase 미설정/실패 시 샘플 데이터로 자동 대체
   ========================================================= */
(function () {
  "use strict";

  const CFG = window.GALLERY_CONFIG || {};
  const FB = window.FIREBASE_CONFIG || {};
  const COLLECTION = CFG.collection || "submissions";

  // ---------- 상태 ----------
  let allItems = [];       // 전체 작품
  let isAdmin = false;
  let usingSample = false;
  let db = null;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const gallery = $("gallery");
  const loading = $("loading");
  const emptyState = $("emptyState");
  const emptyText = $("emptyText");
  const searchInput = $("searchInput");
  const classFilter = $("classFilter");
  const sortSelect = $("sortSelect");
  const countLabel = $("countLabel");
  const sourceNote = $("sourceNote");

  $("year").textContent = new Date().getFullYear();

  // =========================================================
  //  샘플 데이터 (Firebase 없이도 화면 확인용)
  // =========================================================
  function sampleData() {
    const now = Date.now();
    const day = 86400000;
    const seed = [
      ["김하늘", "봄의 정원", "3학년 2반", 0],
      ["이서준", "우리 강아지", "3학년 2반", 1],
      ["박지우", "", "4학년 1반", 1],
      ["최유나", "바다 풍경", "4학년 1반", 2],
      ["정민재", "노을 하늘", "5학년 3반", 3],
      ["한소미", "예쁜 꽃", "3학년 2반", 4],
      ["오지호", "밤하늘 별", "5학년 3반", 5],
      ["서다은", "가을 나무", "4학년 1반", 6],
      ["문준우", "", "5학년 3반", 7],
    ];
    return seed.map(([student, title, cls, ago], i) => ({
      id: "sample-" + i,
      student,
      title,
      classCode: cls,
      type: "image",
      hidden: false,
      date: new Date(now - ago * day - i * 3600000),
      imageURL: `https://picsum.photos/seed/artable${i}/600/600`,
    }));
  }

  // =========================================================
  //  Firebase
  // =========================================================
  function firebaseUsable() {
    return (
      !CFG.useSampleData &&
      typeof firebase !== "undefined" &&
      FB.apiKey &&
      FB.projectId &&
      !String(FB.apiKey).includes("YOUR_")
    );
  }

  function mapDoc(id, d) {
    let date = new Date();
    const raw = d[CFG.dateField || "created_at"];
    if (raw && typeof raw.toDate === "function") date = raw.toDate();
    else if (raw) date = new Date(raw);
    return {
      id,
      student: d.student_nickname || d.student || "이름 없음",
      title: d.title || "",
      classCode: d.class_code || d.className || "",
      type: d.type || "image",
      hidden: d.hidden === true,
      date,
      imageURL: d.download_url || d.imageURL || "",
    };
  }

  function startFirebase() {
    try {
      firebase.initializeApp(FB);
      db = firebase.firestore();
    } catch (e) {
      console.warn("Firebase 초기화 실패 → 샘플로 대체:", e);
      loadSample();
      return;
    }

    // 실시간 구독: 새 작품이 올라오면 자동 반영됩니다.
    db.collection(COLLECTION).onSnapshot(
      (snap) => {
        const items = [];
        snap.forEach((doc) => {
          const m = mapDoc(doc.id, doc.data());
          if (m.imageURL) items.push(m);
        });
        if (items.length === 0 && allItems.length === 0) {
          // 데이터가 아직 없으면 샘플을 보여주되, 실시간 구독은 유지
          usingSample = true;
          allItems = sampleData();
          sourceNote.textContent = "표시 중: 샘플 데이터 (아직 등록된 작품이 없어요)";
        } else {
          usingSample = false;
          allItems = items;
          sourceNote.textContent = "표시 중: 실시간 Firebase 데이터";
        }
        refreshUI();
      },
      (err) => {
        console.warn("Firestore 구독 오류 → 샘플로 대체:", err);
        loadSample();
      }
    );
  }

  function loadSample() {
    usingSample = true;
    allItems = sampleData();
    sourceNote.textContent = "표시 중: 샘플 데이터 (Firebase 미연결)";
    refreshUI();
  }

  // =========================================================
  //  렌더링 + 필터/검색/정렬
  // =========================================================
  function refreshUI() {
    loading.hidden = true;
    populateClassFilter();
    applyFilters();
  }

  function populateClassFilter() {
    const current = classFilter.value;
    const classes = [...new Set(allItems.map((a) => a.classCode).filter(Boolean))].sort();
    classFilter.innerHTML =
      '<option value="">전체 학급</option>' +
      classes.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");
    if (classes.includes(current)) classFilter.value = current;
  }

  function applyFilters() {
    const q = searchInput.value.trim().toLowerCase();
    const cls = classFilter.value;
    const sort = sortSelect.value;

    let list = allItems.filter((a) => (isAdmin ? true : !a.hidden));
    if (cls) list = list.filter((a) => a.classCode === cls);
    if (q) list = list.filter((a) => a.student.toLowerCase().includes(q) || a.title.toLowerCase().includes(q));

    list.sort((a, b) => (sort === "oldest" ? a.date - b.date : b.date - a.date));

    render(list);
  }

  function render(list) {
    countLabel.textContent = list.length;
    gallery.innerHTML = "";

    if (list.length === 0) {
      gallery.hidden = true;
      emptyState.hidden = false;
      emptyText.textContent = allItems.length === 0 ? "아직 등록된 작품이 없어요." : "조건에 맞는 작품이 없어요.";
      return;
    }
    emptyState.hidden = true;
    gallery.hidden = false;

    const frag = document.createDocumentFragment();
    list.forEach((item, i) => {
      const card = document.createElement("div");
      card.className = "card";
      card.style.animationDelay = Math.min(i * 40, 400) + "ms";
      if (item.hidden) card.style.opacity = "0.5";
      card.innerHTML = `
        <div class="card-thumb">
          ${item.classCode ? `<span class="card-badge">${escapeHtml(item.classCode)}</span>` : ""}
          <img loading="lazy" src="${escapeAttr(item.imageURL)}" alt="${escapeAttr(item.student)}의 작품" />
        </div>
        <div class="card-body">
          <p class="card-student">${escapeHtml(item.student)}</p>
          ${item.title ? `<p class="card-title">${escapeHtml(item.title)}</p>` : ""}
          <p class="card-date">${formatDate(item.date)}</p>
        </div>`;
      card.addEventListener("click", () => openModal(item));
      frag.appendChild(card);
    });
    gallery.appendChild(frag);
  }

  // =========================================================
  //  모달 (큰 이미지 보기)
  // =========================================================
  const modal = $("modal");
  let currentItem = null;

  function openModal(item) {
    currentItem = item;
    $("modalImage").src = item.imageURL;
    $("modalImage").alt = item.student + "의 작품";
    $("modalStudent").textContent = item.student;
    $("modalTitle").textContent = item.title || "";
    $("modalTitle").hidden = !item.title;
    $("modalMeta").textContent = [item.classCode, formatDate(item.date)].filter(Boolean).join(" · ");

    const dl = $("downloadBtn");
    dl.href = item.imageURL;
    dl.setAttribute("download", `${item.student}_${formatDate(item.date)}.jpg`);

    document.querySelectorAll(".admin-only").forEach((el) => (el.hidden = !isAdmin));
    modal.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    modal.hidden = true;
    currentItem = null;
    document.body.style.overflow = "";
  }

  modal.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeModal));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeModal(); });

  // 다운로드: 크로스 오리진이면 blob으로 강제 저장, 실패 시 새 탭
  $("downloadBtn").addEventListener("click", async (e) => {
    if (!currentItem) return;
    e.preventDefault();
    const url = currentItem.imageURL;
    try {
      const res = await fetch(url, { mode: "cors" });
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${currentItem.student}_${formatDate(currentItem.date)}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      window.open(url, "_blank");
    }
  });

  // 공유 (SNS)
  $("shareBtn").addEventListener("click", async () => {
    if (!currentItem) return;
    const shareData = {
      title: "Artable 미술 갤러리",
      text: `${currentItem.student} 학생의 작품${currentItem.title ? " '" + currentItem.title + "'" : ""}`,
      url: currentItem.imageURL,
    };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(currentItem.imageURL);
        alert("이미지 링크를 복사했어요!");
      }
    } catch (_) { /* 사용자가 취소 */ }
  });

  // 숨김
  $("hideBtn").addEventListener("click", async () => {
    if (!currentItem) return;
    const item = currentItem;
    if (usingSample || !db) {
      item.hidden = !item.hidden;
    } else {
      try { await db.collection(COLLECTION).doc(item.id).update({ hidden: !item.hidden }); }
      catch (e) { alert("숨김 처리에 실패했어요: " + e.message); return; }
    }
    closeModal();
    if (usingSample) refreshUI();
  });

  // 삭제
  $("deleteBtn").addEventListener("click", async () => {
    if (!currentItem) return;
    if (!confirm(`${currentItem.student} 학생의 작품을 삭제할까요?\n(되돌릴 수 없어요)`)) return;
    const item = currentItem;
    if (usingSample || !db) {
      allItems = allItems.filter((a) => a.id !== item.id);
      closeModal();
      refreshUI();
    } else {
      try { await db.collection(COLLECTION).doc(item.id).delete(); closeModal(); }
      catch (e) { alert("삭제에 실패했어요: " + e.message); }
    }
  });

  // =========================================================
  //  관리자 모드
  // =========================================================
  $("adminToggle").addEventListener("click", () => {
    if (isAdmin) { setAdmin(false); return; }
    const pw = prompt("관리자 비밀번호를 입력하세요");
    if (pw === null) return;
    if (pw === (CFG.adminPassword || "")) setAdmin(true);
    else alert("비밀번호가 올바르지 않아요.");
  });
  $("adminLogout").addEventListener("click", () => setAdmin(false));

  function setAdmin(on) {
    isAdmin = on;
    $("adminBanner").hidden = !on;
    $("adminToggle").textContent = on ? "🔓" : "🔒";
    applyFilters();
  }

  // =========================================================
  //  이벤트 + 유틸
  // =========================================================
  searchInput.addEventListener("input", debounce(applyFilters, 200));
  classFilter.addEventListener("change", applyFilters);
  sortSelect.addEventListener("change", applyFilters);

  function formatDate(d) {
    if (!(d instanceof Date) || isNaN(d)) return "";
    return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  }
  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // =========================================================
  //  시작
  // =========================================================
  if (firebaseUsable()) {
    startFirebase();
  } else {
    loadSample();
  }
})();
