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
  // 학교별 비밀번호 { 학교명: 비번 } — 걸린 학교만 들어있음
  let schoolPasswords = {};
  // 이번 방문에서 비번을 통과해 열어 둔 학교
  const unlockedSchools = new Set();
  const SETTINGS_COLLECTION = "school_settings";

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
  const controls = document.querySelector(".controls");
  const schoolHeader = $("schoolHeader");
  const schoolTitle = $("schoolTitle");

  // 학교는 홈 카드로 고르므로 학급 드롭다운은 숨김
  if (classFilter) { const c = classFilter.closest(".control"); if (c) c.style.display = "none"; }

  // 현재 보고 있는 학교 (null = 학교 목록 홈)
  let currentSchool = null;

  $("backHome").addEventListener("click", () => {
    currentSchool = null;
    searchInput.value = "";
    refreshUI();
    window.scrollTo(0, 0);
  });

  // 학교 갤러리로 들어가기 (비번이 걸려 있으면 확인)
  function enterSchool(school) {
    const pw = schoolPasswords[school];
    if (pw && !isAdmin && !unlockedSchools.has(school)) {
      const entered = prompt(`🔒 ${school} 갤러리\n\n비밀번호를 입력하세요`);
      if (entered === null) return;                 // 취소
      if (entered !== pw) { alert("비밀번호가 올바르지 않아요."); return; }
      unlockedSchools.add(school);
    }
    currentSchool = school;
    searchInput.value = "";
    refreshUI();
    window.scrollTo(0, 0);
  }

  // 관리자: 학교 비밀번호 설정/변경/해제
  function manageSchoolPassword(school) {
    const cur = schoolPasswords[school] || "";
    const msg = cur
      ? `${school}\n\n현재 비밀번호: ${cur}\n\n새 비밀번호를 입력하세요.\n(빈칸으로 두고 확인하면 비밀번호 해제 → 공개)`
      : `${school}\n\n지금은 비밀번호가 없어요 (공개).\n\n걸어 둘 비밀번호를 입력하세요.\n(빈칸이면 계속 공개)`;
    const val = prompt(msg, cur);
    if (val === null) return;
    setSchoolPassword(school, val.trim());
  }

  async function setSchoolPassword(school, pw) {
    if (pw) schoolPasswords[school] = pw;
    else { delete schoolPasswords[school]; unlockedSchools.delete(school); }

    if (db && !usingSample) {
      const id = school.replace(/\//g, "_");
      try {
        await db.collection(SETTINGS_COLLECTION).doc(id).set({ school, password: pw || "" }, { merge: true });
      } catch (e) { alert("비밀번호 저장에 실패했어요: " + e.message); }
    } else {
      // 샘플/오프라인: 이 브라우저에만 저장(데모용)
      if (pw) localStorage.setItem("schoolPw:" + school, pw);
      else localStorage.removeItem("schoolPw:" + school);
    }
    alert(pw ? `🔒 ${school} 비밀번호를 설정했어요.` : `🔓 ${school} 비밀번호를 해제했어요 (공개).`);
    refreshUI();
  }

  // 데모(샘플/오프라인) 모드에서 이 브라우저에 저장된 학교 비번 불러오기
  function loadLocalPasswords() {
    schoolPasswords = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("schoolPw:")) {
        const v = localStorage.getItem(k);
        if (v) schoolPasswords[k.slice("schoolPw:".length)] = v;
      }
    }
  }

  $("year").textContent = new Date().getFullYear();

  // =========================================================
  //  샘플 데이터 (Firebase 없이도 화면 확인용)
  // =========================================================
  function sampleData() {
    const now = Date.now();
    const day = 86400000;
    const seed = [
      ["김하늘", "봄의 정원", "논곡초등학교", 0],
      ["이서준", "우리 강아지", "논곡초등학교", 1],
      ["박지우", "", "부일초등학교", 1],
      ["최유나", "바다 풍경", "부일초등학교", 2],
      ["정민재", "노을 하늘", "논곡초등학교", 3],
      ["한소미", "예쁜 꽃", "논곡초등학교", 4],
      ["오지호", "밤하늘 별", "부일초등학교", 5],
      ["서다은", "가을 나무", "부일초등학교", 6],
      ["문준우", "", "논곡초등학교", 7],
    ];
    return seed.map(([student, title, school, ago], i) => ({
      id: "sample-" + i,
      student,
      title,
      classCode: school,
      school,
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
    const driveLink = d.google_drive_link || "";
    // 표시용 URL 우선순위: 썸네일 → (구글드라이브 링크→이미지 변환) → 레거시 download_url
    const url =
      d.thumbnail_url ||
      d.download_url ||
      d.imageURL ||
      driveImage(driveLink) ||
      "";
    const fileName = d.file_name || "";
    const ext = (d.file_extension || extOf(fileName) || extOf(url) || "").toLowerCase().replace(/^\./, "");
    const type = d.file_type || d.type || (ext ? kindOfExt(ext) : "image");
    return {
      id,
      student: d.student_nickname || d.student || "이름 없음",
      title: d.title || "",
      classCode: d.class_code || d.className || "",
      // 그룹 이름: 학교명 우선 → 없으면 반 이름(class_name) → 그래도 없을 때만 코드.
      // (신규 클래스는 school_name이 비어 있어 예전엔 코드가 그대로 노출됐음)
      school: d.school_name || d.class_name || d.className || d.class_code || "",
      type,
      ext,
      fileName,
      hidden: d.hidden === true,
      date,
      imageURL: url,
      // 실제 파일(원본) 링크 — 다운로드/열기에 사용
      driveLink: driveLink || d.download_url || url,
    };
  }

  // 구글 드라이브 파일 링크에서 파일 ID를 뽑아 이미지 썸네일 URL로 변환
  function driveImage(link) {
    if (!link) return "";
    const m = String(link).match(/\/d\/([a-zA-Z0-9_-]+)/) || String(link).match(/[?&]id=([a-zA-Z0-9_-]+)/);
    return m ? `https://lh3.googleusercontent.com/d/${m[1]}=w1000` : "";
  }

  // 실제 파일 다운로드 URL. Drive 링크(/view = HTML 페이지)를 원본 파일 URL로 변환
  // — 이걸 안 쓰면 HTML 페이지가 .pdf 등으로 저장돼 "유효하지 않은 PDF" 오류가 남.
  function fileDownloadURL(item) {
    const link = String(item.driveLink || "");
    const m = link.match(/\/d\/([a-zA-Z0-9_-]+)/) || link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
    return item.driveLink || item.imageURL;
  }

  // 파일명/URL에서 확장자 추출 (쿼리스트링 제거)
  function extOf(s) {
    if (!s) return "";
    const clean = String(s).split("?")[0].split("#")[0];
    const m = clean.match(/\.([a-zA-Z0-9]+)$/);
    return m ? m[1].toLowerCase() : "";
  }
  function kindOfExt(ext) {
    if (ext === "pdf") return "pdf";
    if (ext === "psd") return "psd";
    return "image";
  }
  // 이미지로 미리보기할 수 있는지 (pdf/psd는 브라우저에서 썸네일 불가)
  function isPreviewable(item) {
    return item.type === "image" || ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"].includes(item.ext);
  }
  // 다운로드 파일명 (원본 확장자 유지 — 레이어가 있는 PSD 등이 깨지지 않도록)
  function downloadName(item) {
    const ext = item.ext || (item.type === "pdf" ? "pdf" : item.type === "psd" ? "psd" : "jpg");
    const safeStudent = String(item.student).replace(/[\\/:*?"<>|]/g, "_");
    return `${safeStudent}_${formatDate(item.date)}.${ext}`;
  }
  function typeLabel(item) {
    if (item.type === "pdf") return "PDF";
    if (item.type === "psd") return "PSD · 레이어 파일";
    return "";
  }

  // 미리보기 불가/로드 실패 시 보여줄 타일 (깨진 이미지 대신)
  function docTileHTML(item) {
    const isPdf = item.type === "pdf" || item.ext === "pdf";
    const isPsd = item.type === "psd" || item.ext === "psd";
    const icon = isPdf ? "📄" : isPsd ? "🗂️" : "🖼️";
    const label = isPdf ? "PDF" : isPsd ? "PSD" : "이미지";
    return `<div class="card-doc"><span class="card-doc-icon">${icon}</span><span class="card-doc-type">${escapeHtml(label)}</span></div>`;
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

    // 학교별 비밀번호 실시간 구독 (관리자 페이지에서 설정한 값)
    db.collection(SETTINGS_COLLECTION).onSnapshot(
      (snap) => {
        const map = {};
        snap.forEach((doc) => {
          const d = doc.data() || {};
          const name = d.school || doc.id;
          if (d.password) map[name] = d.password;
        });
        schoolPasswords = map;
        refreshUI();
      },
      (err) => console.warn("school_settings 구독 오류:", err)
    );

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
    loadLocalPasswords();
    sourceNote.textContent = "표시 중: 샘플 데이터 (Firebase 미연결)";
    refreshUI();
  }

  // =========================================================
  //  렌더링 + 필터/검색/정렬
  // =========================================================
  function refreshUI() {
    loading.hidden = true;
    const home = currentSchool === null;
    // 홈에서는 검색/정렬 컨트롤 숨기고, 학교 상세에서는 표시
    if (controls) controls.hidden = home;
    schoolHeader.hidden = home;
    if (!home) schoolTitle.textContent = currentSchool;

    if (home) renderHome();
    else applyFilters();
  }

  // 학교 목록 홈: 학교별 카드(대표 이미지 + 작품 수)
  function renderHome() {
    const visible = allItems.filter((a) => (isAdmin ? true : !a.hidden));
    const map = new Map();
    visible.forEach((a) => {
      const key = a.school || "기타";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(a);
    });
    const schools = [...map.entries()].sort((a, b) => b[1].length - a[1].length);

    countLabel.textContent = schools.length;
    gallery.innerHTML = "";
    if (schools.length === 0) {
      gallery.hidden = true; emptyState.hidden = false;
      emptyText.textContent = "아직 등록된 작품이 없어요.";
      return;
    }
    emptyState.hidden = true; gallery.hidden = false;

    const frag = document.createDocumentFragment();
    schools.forEach(([school, items], i) => {
      const sorted = items.slice().sort((a, b) => b.date - a.date);
      const cover = sorted.find(isPreviewable) || sorted[0];
      const card = document.createElement("div");
      card.className = "card school-card";
      card.style.animationDelay = Math.min(i * 40, 400) + "ms";
      const coverHTML = cover && isPreviewable(cover)
        ? `<img loading="lazy" src="${escapeAttr(cover.imageURL)}" alt="${escapeAttr(school)}" />`
        : docTileHTML(cover || {});
      const locked = !!schoolPasswords[school];
      card.innerHTML = `
        <div class="card-thumb">
          ${coverHTML}
          <span class="school-count">${items.length}</span>
          ${locked ? `<span class="school-lock" title="비밀번호 잠김">🔒</span>` : ""}
        </div>
        <div class="card-body">
          <p class="card-student">🏫 ${escapeHtml(school)}</p>
          <p class="card-date">최근 ${formatDate(sorted[0].date)}</p>
          ${isAdmin ? `<button class="school-pw-btn">${locked ? "🔒 비밀번호 변경/해제" : "🔓 비밀번호 걸기"}</button>` : ""}
        </div>`;
      const img = card.querySelector(".card-thumb img");
      if (img) img.addEventListener("error", () => { img.outerHTML = docTileHTML(cover || {}); });
      const pwBtn = card.querySelector(".school-pw-btn");
      if (pwBtn) pwBtn.addEventListener("click", (e) => { e.stopPropagation(); manageSchoolPassword(school); });
      card.addEventListener("click", () => enterSchool(school));
      frag.appendChild(card);
    });
    gallery.appendChild(frag);
  }

  function applyFilters() {
    const q = searchInput.value.trim().toLowerCase();
    const sort = sortSelect.value;

    let list = allItems.filter((a) => (isAdmin ? true : !a.hidden));
    if (currentSchool) list = list.filter((a) => (a.school || "기타") === currentSchool);
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
      const thumb = isPreviewable(item)
        ? `<img loading="lazy" src="${escapeAttr(item.imageURL)}" alt="${escapeAttr(item.student)}의 작품" />`
        : docTileHTML(item);
      card.innerHTML = `
        <div class="card-thumb">
          ${item.school ? `<span class="card-badge">${escapeHtml(item.school)}</span>` : ""}
          ${thumb}
        </div>
        <div class="card-body">
          <p class="card-student">${escapeHtml(item.student)}</p>
          ${item.title ? `<p class="card-title">${escapeHtml(item.title)}</p>` : ""}
          <p class="card-date">${formatDate(item.date)}</p>
        </div>`;
      // 이미지 로드 실패 시 깨진 이미지 대신 문서/플레이스홀더 타일로 대체
      const img = card.querySelector(".card-thumb img");
      if (img) img.addEventListener("error", () => { img.outerHTML = docTileHTML(item); });
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
    const modalImg = $("modalImage");
    if (isPreviewable(item)) {
      modalImg.src = item.imageURL;
      modalImg.alt = item.student + "의 작품";
      modalImg.hidden = false;
    } else {
      // PDF/PSD 등은 브라우저에서 미리보기할 수 없으니 안내만 표시하고 다운로드로 유도합니다.
      modalImg.removeAttribute("src");
      modalImg.hidden = true;
    }
    $("modalStudent").textContent = item.student;
    const label = typeLabel(item);
    $("modalTitle").textContent = item.title || (label ? label : "");
    $("modalTitle").hidden = !item.title && !label;
    $("modalMeta").textContent = [item.school, label, formatDate(item.date)].filter(Boolean).join(" · ");

    const dl = $("downloadBtn");
    dl.href = fileDownloadURL(item);
    dl.setAttribute("download", downloadName(item));

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
    // 미리보기 가능한 이미지는 표시 URL을, 그 외(PDF/PSD)는 원본 드라이브 링크를 사용
    const url = fileDownloadURL(currentItem);
    if (url.includes("uc?export=download")) {
      // Drive 직접 다운로드 URL: 브라우저가 원본 파일을 그대로 내려받음 (HTML 페이지 아님)
      window.open(url, "_blank");
      return;
    }
    try {
      const res = await fetch(url, { mode: "cors" });
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = downloadName(currentItem);
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
    refreshUI();
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
