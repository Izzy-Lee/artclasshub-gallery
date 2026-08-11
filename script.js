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
  // (예전 방식. 스프레드시트 "클래스" 탭에 줄이 있는 반은 그쪽이 우선입니다.)
  let schoolPasswords = {};
  // 이번 방문에서 비번을 통과해 열어 둔 학교
  const unlockedSchools = new Set();
  const SETTINGS_COLLECTION = "school_settings";

  // ---------- 클래스(반) 등록부 = 스프레드시트 "클래스" 탭 ----------
  //   A 클래스명 | B 코드 | C 비번 | D 사진폴더명 | E 메모
  //   · 반 이름: ?class=코드 링크의 제목을 코드가 아니라 반 이름으로 보여준다.
  //   · 비번   : 반마다 다른 비밀번호. 대조는 Apps Script에서만 하고,
  //              브라우저로는 '잠김/공개'만 내려온다.
  //   · 사진폴더명: 드라이브의 기관 폴더 이름이 반 이름과 다를 때 이어 준다.
  const CLASS_API = CFG.classApi || "";
  let classByCode = {};      // 소문자 코드 → { name, code, org, locked }
  let classByName = {};      // 소문자 클래스명/사진폴더명 → 같은 객체
  const unlockedClasses = new Set();   // 이번 방문에 비번을 통과한 반(코드 소문자)
  let classRegistryLoaded = false;     // 시트를 아직 못 읽었으면 '잠긴 반일 수도' 있다고 본다
  // 반 코드 → 반 이름 (Firestore classes 컬렉션 — 시트에 줄이 없어도 이름은 제대로 나오게)
  let classNamesFromDB = {};

  // 지금 브라우저가 실제로 실행 중인 코드의 버전.
  // 배포 워크플로가 아래 자리표시자를 커밋 해시로 바꿔 넣는다(로컬에서는 그대로 보임).
  // 화면 맨 아래에 찍어서 "고쳤는데 왜 그대로지?"를 개발자 도구 없이 구별한다.
  const BUILD = "7e4d836";

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

  // 외부 공개용 URL 잠금: ?school= 또는 ?class= 가 있으면 그 학교/반만 보이고 홈(다른 학교)은 숨김
  const _params = new URLSearchParams(location.search);
  const lockSchool = (_params.get("school") || "").trim();
  const lockClass = (_params.get("class") || "").trim();
  const isLocked = !!(lockSchool || lockClass);
  // 이름 탭으로 고른 학생('' = 전체)
  let nameFilter = "";

  // ---------- 작품 분류(카테고리) ----------
  // 작품 문서의 category 필드로 나눠 본다. 분류 목록(마스터)은 설정 컬렉션의
  // 예약 문서 하나에 모아 둔다 — 아직 아무 작품에도 안 쓴 분류도 메뉴에 남기려고.
  // ⚠️ Firestore는 앞뒤가 __ 인 문서 ID(__categories__ 같은)를 예약어로 막는다.
  //    학교 비번 문서와 섞이지 않으면서 학교 이름과 겹칠 일도 없는 이름을 쓴다.
  const CATEGORY_DOC = "gallery-categories";
  const CAT_NONE = "__none__";          // '미분류' 탭 값 (실제 분류 이름과 겹칠 일 없게)
  let categories = [];                  // 관리자가 만든 분류 목록
  let catFilter = "";                   // '' = 전체

  $("backHome").addEventListener("click", () => {
    currentSchool = null;
    nameFilter = "";
    catFilter = "";
    searchInput.value = "";
    refreshUI();
    window.scrollTo(0, 0);
  });

  // 학교 갤러리로 들어가기 (비번이 걸려 있으면 확인)
  function enterSchool(school) {
    // "클래스" 시트에 줄이 있는 반은 그쪽 비번을 쓴다 — refreshUI가 비밀번호 화면을 띄운다.
    if (regForGroup(school)) {
      currentSchool = school;
      nameFilter = "";
      catFilter = "";
      searchInput.value = "";
      refreshUI();
      window.scrollTo(0, 0);
      return;
    }
    const pw = schoolPasswords[school];
    if (pw && !isAdmin && !unlockedSchools.has(school)) {
      const entered = prompt(`🔒 ${school} 갤러리\n\n비밀번호를 입력하세요`);
      if (entered === null) return;                 // 취소
      if (entered !== pw) { alert("비밀번호가 올바르지 않아요."); return; }
      unlockedSchools.add(school);
    }
    currentSchool = school;
    nameFilter = "";
    catFilter = "";
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

  // =========================================================
  //  클래스(반) 등록부 — 스프레드시트 "클래스" 탭
  //    반 이름 / 반마다 다른 비밀번호 / 사진 폴더 이름을 여기 한 장에서 관리한다.
  // =========================================================
  function loadClassRegistry() {
    if (!CLASS_API) { classRegistryLoaded = true; return Promise.resolve(); }
    return fetch(CLASS_API + "?classes=1")
      .then((r) => r.json())
      .then((d) => {
        if (!d || !d.ok) return;
        classByCode = {}; classByName = {};
        (d.classes || []).forEach((c) => {
          if (c.code) classByCode[String(c.code).toLowerCase()] = c;
          if (c.name) classByName[String(c.name).toLowerCase()] = c;
          if (c.org) classByName[String(c.org).toLowerCase()] = c;
        });
      })
      .catch(() => { /* 시트를 못 읽어도 갤러리는 그대로 열린다 */ })
      .then(() => { classRegistryLoaded = true; refreshUI(); });
  }

  /// 관리자 모드로 들어오면 앱에서 만든 반 목록을 "클래스" 탭에 채워 넣는다.
  /// (이미 있는 코드는 서버가 건너뛰므로 비번·사진폴더명 칸은 그대로 보존된다.)
  function syncClassesToSheet() {
    if (!CLASS_API) return;
    const list = Object.keys(classNamesFromDB).map((code) => ({
      code: code.toUpperCase(), name: classNamesFromDB[code]
    }));
    if (!list.length) return;
    fetch(CLASS_API, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "syncClasses", secret: CFG.classSecret || "", classes: list })
    })
      .then((r) => r.json())
      .then((d) => { if (d && d.ok && d.added) loadClassRegistry(); })
      .catch(() => {});
  }

  // 코드·반이름·사진폴더명 아무거나로 등록부 한 줄 찾기
  function regFor(key) {
    const k = String(key || "").trim().toLowerCase();
    if (!k) return null;
    return classByCode[k] || classByName[k] || null;
  }

  // 화면에 묶인 이름(학교/반 이름)으로 찾기 — 이름이 안 맞으면 그 그룹 작품의 반코드로도 찾아본다.
  function regForGroup(name) {
    let r = regFor(name);
    if (r) return r;
    const codes = new Set(allItems
      .filter((a) => (a.school || "기타") === name)
      .map((a) => a.classCode).filter(Boolean));
    for (const c of codes) { r = regFor(c); if (r) return r; }
    return null;
  }

  // 지금 보고 있는 범위(링크로 잠긴 반 / 고른 학교)의 등록부 줄
  function currentScopeReg() {
    if (isLocked) return regFor(lockClass || lockSchool);
    if (currentSchool) return regForGroup(currentSchool);
    return null;
  }

  /// 잠금 상태를 다른 스크립트(home-rails.js: 그림책·수업사진 줄)에도 알린다.
  /// 비번을 넣기 전에는 그림책 표지·아이 이름이 한 장도 보이면 안 된다.
  let lockedNow = null;              // null = 아직 한 번도 안 알림(첫 판단은 반드시 알린다)
  function setLocked(on) {
    if (lockedNow === on) return;
    lockedNow = on;
    window.galleryLocked = on;
    document.dispatchEvent(new CustomEvent("gallery-locked", { detail: on }));
  }
  function isGateUp() { return lockedNow !== false; }

  function regKey(reg) { return String(reg.code || reg.name || "").toLowerCase(); }
  function savedPwKey(reg) { return "classPw:" + regKey(reg); }

  // 반 비번을 맞히면 서버가 주는 '사진 열람 표'({org, exp, sig}). 수업 사진을 열 때 같이 보낸다.
  let photoToken = null;

  // 서버(Apps Script)에 비밀번호를 물어본다. 맞으면 true.
  function verifyClassPassword(reg, pw) {
    if (!CLASS_API) return Promise.resolve(false);
    return fetch(CLASS_API, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },   // 프리플라이트 없이(GAS 단순요청)
      body: JSON.stringify({
        action: "classAuth", secret: CFG.classSecret || "",
        code: reg.code || "", "class": reg.name || "", pw: pw
      })
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d || !d.ok) return false;
        if (d.photo) photoToken = d.photo;
        return true;
      })
      .catch(() => false);
  }

  // 이 반이 열려 있는지(공개이거나 이미 비번을 통과했는지)
  function classUnlocked(reg) {
    return !reg || !reg.locked || isAdmin || unlockedClasses.has(regKey(reg));
  }

  // 열린 반 정보를 다른 스크립트(home-rails.js)에도 알린다 — 사진 줄이 같은 비번·폴더 이름을 쓰도록.
  function announceClass(reg, pw) {
    window.galleryClass = reg ? {
      name: reg.name || "", code: reg.code || "", org: reg.org || reg.name || "",
      orgs: reg.orgs || [],            // 사진 폴더 이름들(쉼표로 여러 개 적을 수 있음)
      src: reg.src || "",              // 시트 F열: report = 기존 리포트 웹앱에서 사진을 가져온다
      pw: pw || "", photoToken: photoToken, admin: isAdmin
    } : null;
    document.dispatchEvent(new CustomEvent("gallery-class", { detail: window.galleryClass }));
  }

  // 비밀번호 화면 — 반 갤러리 전체를 가린다(작품·그림책·사진 모두).
  let gateBox = null;
  function showGate(reg) {
    if (!gateBox) {
      gateBox = document.createElement("div");
      gateBox.className = "class-gate";
      gateBox.innerHTML =
        '<div class="class-gate-card">' +
          '<div class="class-gate-emoji">🔒</div>' +
          '<h2 class="class-gate-title"></h2>' +
          "<p class=\"class-gate-sub\">우리 반 비밀번호를 넣으면 작품과 수업 사진을 볼 수 있어요.</p>" +
          '<div class="class-gate-row">' +
            '<input type="password" placeholder="비밀번호" autocomplete="current-password" />' +
            "<button type=\"button\">열기</button>" +
          "</div>" +
          '<p class="class-gate-err"></p>' +
        "</div>";
      document.querySelector("main.container").appendChild(gateBox);

      const input = gateBox.querySelector("input");
      const btn = gateBox.querySelector("button");
      const err = gateBox.querySelector(".class-gate-err");
      const submit = () => {
        const reg2 = currentScopeReg();
        const pw = input.value.trim();
        if (!reg2 || !pw) return;
        err.textContent = "여는 중…";
        verifyClassPassword(reg2, pw).then((ok) => {
          if (!ok) { err.textContent = "비밀번호가 올바르지 않아요."; return; }
          err.textContent = "";
          input.value = "";
          unlockedClasses.add(regKey(reg2));
          try { localStorage.setItem(savedPwKey(reg2), pw); } catch (e) {}
          announceClass(reg2, pw);
          refreshUI();
        });
      };
      btn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    }
    gateBox.querySelector(".class-gate-title").textContent = reg.name || "우리 반 갤러리";
    gateBox.hidden = false;
    // 지난번에 넣어 둔 비번이 있으면 조용히 한 번 시도한다(부모님이 매번 안 넣도록).
    let saved = "";
    try { saved = localStorage.getItem(savedPwKey(reg)) || ""; } catch (e) {}
    if (saved && !gateBox.dataset.tried) {
      gateBox.dataset.tried = "1";
      verifyClassPassword(reg, saved).then((ok) => {
        if (!ok) { try { localStorage.removeItem(savedPwKey(reg)); } catch (e) {} return; }
        unlockedClasses.add(regKey(reg));
        announceClass(reg, saved);
        refreshUI();
      });
    }
  }
  function hideGate() { if (gateBox) gateBox.hidden = true; }

  $("year").textContent = new Date().getFullYear();
  if ($("buildStamp")) $("buildStamp").textContent = "버전 " + BUILD;

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
      // 작품 분류(관리자가 지정) — 없으면 '미분류'
      category: String(d.category || "").trim(),
      hidden: d.hidden === true,
      date,
      imageURL: url,
      // 실제 파일(원본) 링크 — 다운로드/열기에 사용
      driveLink: driveLink || d.download_url || url,
      // 저작 구분(투명성 표기) — 앱 업로드 메타데이터의 authorship
      authorship: d.authorship || null,
    };
  }

  // "✍️ 이야기·그림: 학생 직접 / 🧚 밑그림 힌트 사용" 투명성 뱃지
  function authorshipText(item) {
    const a = item.authorship;
    if (!a) return "";
    return "✍️ 이야기·그림 학생 직접" + (a.used_ai_hint === true ? " · 🧚 밑그림 힌트 사용" : "");
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

    // 반 목록(앱이 만든 반) — 작품이 아직 없는 새 반도 이름이 제대로 보이게.
    db.collection("classes").get()
      .then((snap) => {
        snap.forEach((doc) => {
          const c = doc.data() || {};
          const code = String(c.class_code || "").toLowerCase();
          const name = c.class_name || c.school_name || "";
          if (code && name) classNamesFromDB[code] = name;
        });
        refreshUI();
      })
      .catch(() => {});

    // 학교별 비밀번호 실시간 구독 (관리자 페이지에서 설정한 값)
    db.collection(SETTINGS_COLLECTION).onSnapshot(
      (snap) => {
        const map = {};
        snap.forEach((doc) => {
          const d = doc.data() || {};
          // 예전에 Firestore에 저장해 둔 분류가 있으면 합쳐만 준다("분류" 시트 목록을 지우지 않게).
          if (doc.id === CATEGORY_DOC) {
            const old = (Array.isArray(d.list) ? d.list : [])
              .map((c) => String(c || "").trim()).filter(Boolean);
            categories = [...new Set(categories.concat(old))];
            return;
          }
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
    loadLocalCategories();
    sourceNote.textContent = "표시 중: 샘플 데이터 (Firebase 미연결)";
    refreshUI();
  }

  // =========================================================
  //  렌더링 + 필터/검색/정렬
  // =========================================================
  function refreshUI() {
    loading.hidden = true;

    // 반 비밀번호(스프레드시트 "클래스" 탭)가 걸려 있으면 통과할 때까지 아무것도 안 보여준다.
    // 시트를 아직 못 읽었을 때도(잠긴 반인지 모를 때) 일단 가린다 —
    // 그렇지 않으면 비번을 넣기 전에 그림책·이름표가 잠깐 보였다 사라진다.
    const reg = currentScopeReg();
    const waiting = isLocked && !classRegistryLoaded && !isAdmin;
    if (waiting || (reg && !classUnlocked(reg))) {
      setLocked(true);
      if (controls) controls.hidden = true;
      schoolHeader.hidden = true;       // 줄(그림책·수업모습)도 같이 닫힌다
      clearNameTabs();
      gallery.hidden = true;
      emptyState.hidden = true;
      loading.hidden = !waiting;        // 아직 확인 중이면 '불러오는 중'을 남겨 둔다
      if (!waiting) showGate(reg);
      return;
    }
    setLocked(false);
    hideGate();
    if (reg && (!window.galleryClass || window.galleryClass.code !== reg.code)) {
      let pw = "";
      try { pw = localStorage.getItem(savedPwKey(reg)) || ""; } catch (e) {}
      announceClass(reg, pw);
    }

    // 외부 공개 잠금: 홈/다른 학교를 숨기고 지정한 학교(반)만 보여준다.
    if (isLocked) {
      if (controls) controls.hidden = false;
      schoolHeader.hidden = false;
      const backBtn = $("backHome");
      if (backBtn) backBtn.style.display = "none";   // 전체 학교로 나가는 버튼 숨김
      schoolTitle.textContent = lockedTitle();
      renderNameTabs();
      renderCatTabs();
      applyFilters();
      return;
    }

    const home = currentSchool === null;
    // 홈에서는 검색/정렬 컨트롤 숨기고, 학교 상세에서는 표시
    if (controls) controls.hidden = home;
    schoolHeader.hidden = home;
    if (!home) { schoolTitle.textContent = currentSchool; renderNameTabs(); renderCatTabs(); }
    else clearNameTabs();

    if (home) renderHome();
    else applyFilters();
  }

  // 잠금 화면 제목: 학교명 → 등록부("클래스" 시트) 반 이름 → Firestore 반 이름
  //               → 그 반 작품의 학교명 → 그래도 없으면 코드.
  // (작품이 아직 한 점도 없는 새 반은 예전엔 코드 'TEYNFZ'가 그대로 보였다)
  function lockedTitle() {
    if (lockSchool) return lockSchool;
    const reg = regFor(lockClass);
    if (reg && reg.name) return reg.name;
    const fromDB = classNamesFromDB[String(lockClass).toLowerCase()];
    if (fromDB) return fromDB;
    const one = allItems.find((a) => (a.classCode || "") === lockClass);
    return (one && one.school) ? one.school : lockClass;
  }

  // 현재 화면 범위(잠금/선택 학교)에 해당하는 작품들 — 이름 탭 계산용
  function scopedItems() {
    let list = allItems.filter((a) => (isAdmin ? true : !a.hidden));
    if (isLocked) {
      if (lockClass) list = list.filter((a) => (a.classCode || "") === lockClass);
      else if (lockSchool) list = list.filter((a) => (a.school || "") === lockSchool);
    } else if (currentSchool) {
      list = list.filter((a) => (a.school || "기타") === currentSchool);
    }
    return list;
  }

  // 이름 탭 선택을 다른 스크립트(그림책 레일)에도 알린다.
  function emitNameFilter() {
    document.dispatchEvent(new CustomEvent("gallery-namefilter", { detail: nameFilter }));
  }

  // 지금 보고 있는 반의 그림책 지은이들 (home-rails.js가 알려준다).
  // 작품(submissions)만 보면 그림책만 만든 아이가 이름 탭에서 통째로 빠진다.
  let bookStudents = [];
  document.addEventListener("gallery-booknames", (e) => {
    if (isGateUp()) return;             // 비번 화면에서는 이름표도 만들지 않는다
    const next = [...new Set((Array.isArray(e.detail) ? e.detail : [])
      .map((n) => String(n || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
    if (next.join("|") === bookStudents.join("|")) return;   // 같은 목록이면 다시 그리지 않는다
    bookStudents = next;
    renderNameTabs();
  });

  // 아이 이름 탭 — 눌러서 그 아이 작품만 보기 (작품 + 그림책 지은이 합집합)
  function renderNameTabs() {
    const box = $("nameTabs");
    if (!box) return;
    const names = [...new Set(scopedItems().map((a) => (a.student || "").trim()).filter(Boolean)
      .concat(bookStudents))]
      .sort((a, b) => a.localeCompare(b, "ko"));
    if (names.length <= 1) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = "";
    const mk = (label, val) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "name-tab" + (nameFilter === val ? " on" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        nameFilter = val;
        searchInput.value = "";
        emitNameFilter();
        renderNameTabs();
        applyFilters();
      });
      return b;
    };
    box.appendChild(mk("전체", ""));
    names.forEach((n) => box.appendChild(mk(n, n)));

    // 관리자 + 특정 학생 선택 중이면 그 학생 작품 전체의 이름을 바꾸는 버튼을 붙인다.
    // ('모름' 같은 임시 이름을 실제 이름으로 정리할 때)
    if (isAdmin && nameFilter) {
      const rn = document.createElement("button");
      rn.type = "button";
      rn.className = "name-tab rename";
      rn.textContent = "✏️ 이름 바꾸기";
      rn.addEventListener("click", renameStudent);
      box.appendChild(rn);

      const mv = document.createElement("button");
      mv.type = "button";
      mv.className = "name-tab rename";
      mv.textContent = "🔀 반 옮기기";
      mv.addEventListener("click", moveStudent);
      box.appendChild(mv);
    }
  }

  /// 지금 고른 학생의 작품과 그림책을 다른 반으로 통째로 옮긴다.
  /// (아이가 반을 옮겼거나, 처음에 반을 잘못 골라 들어간 경우)
  async function moveStudent() {
    const who = nameFilter;
    const reg = currentScopeReg();
    const list = Object.keys(classByCode).map((k) => classByCode[k])
      .filter((c) => !reg || c.code !== reg.code)
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", "ko"));
    if (!list.length) { alert("옮길 반 목록을 불러오지 못했어요."); return; }

    const menu = list.map((c, i) => `${i + 1}. ${c.name} (${c.code})`).join("\n");
    const pick = window.prompt(`'${who}' 학생을 어느 반으로 옮길까요?\n\n${menu}\n\n번호나 반 코드를 넣어 주세요.`, "");
    if (pick === null) return;
    const key = String(pick).trim();
    const target = /^\d+$/.test(key) ? list[Number(key) - 1]
      : list.find((c) => c.code.toLowerCase() === key.toLowerCase() || c.name === key);
    if (!target) { alert("그런 반을 찾지 못했어요."); return; }

    const works = scopedItems().filter((a) => (a.student || "").trim() === who);
    if (!confirm(`'${who}' 학생을 ${target.name} 으로 옮길까요?\n\n· 작품 ${works.length}점\n· 그림책도 함께 옮겨집니다`)) return;

    // ① 작품(Firestore) — 반 코드와 반 이름을 함께 바꿔야 화면에서도 그 반으로 묶인다.
    try {
      if (works.length) {
        await batchUpdate(works, {
          class_code: target.code,
          class_name: target.name,
          school_name: works.some((w) => w.school && w.school !== w.classCode) ? target.name : ""
        });
      }
    } catch (e) {
      alert("작품을 옮기지 못했어요: " + (e && e.message ? e.message : e));
      return;
    }

    // ② 그림책(Apps Script 기록 시트)
    let books = 0;
    if (CFG.booksApi) {
      try {
        const res = await fetch(CFG.booksApi, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            action: "moveBook", secret: CFG.booksSecret || "",
            adminKey: CFG.adminPassword || "",
            student: who, fromClass: reg ? reg.code : "", toClass: target.code
          })
        }).then((r) => r.json());
        books = (res && res.moved) || 0;
      } catch (e) { /* 그림책이 없으면 그냥 넘어간다 */ }
    }

    alert(`${target.name} 으로 옮겼어요.\n\n· 작품 ${works.length}점\n· 그림책 ${books}권`);
    nameFilter = "";
    emitNameFilter();
    location.reload();      // 목록·레일을 새로 읽는다
  }

  // 지금 고른 학생(nameFilter)의 작품 전부를 새 이름으로 일괄 변경.
  async function renameStudent() {
    const oldName = nameFilter;
    const input = window.prompt(`'${oldName}' 작품들을 어떤 이름으로 바꿀까요?`, "");
    if (input === null) return;
    const newName = input.trim();
    if (!newName || newName === oldName) return;
    const targets = scopedItems().filter((a) => (a.student || "").trim() === oldName);
    if (!targets.length) { alert("바꿀 작품이 없어요."); return; }
    if (!confirm(`작품 ${targets.length}개의 학생 이름을 '${oldName}' → '${newName}' 으로 바꿀까요?`)) return;
    try {
      const batch = db.batch();
      targets.forEach((a) => batch.update(db.collection(COLLECTION).doc(a.id), { student_nickname: newName }));
      await batch.commit();
      targets.forEach((a) => { a.student = newName; });   // 실시간 스냅샷이 오기 전 화면 즉시 반영
      nameFilter = newName;
      emitNameFilter();
      renderNameTabs();
      applyFilters();
    } catch (e) {
      alert("이름을 바꾸지 못했어요: " + (e && e.message ? e.message : e)
        + "\n\nFirestore 규칙이 쓰기를 막고 있으면 숨김/삭제처럼 쓰기 허용이 필요해요.");
    }
  }

  function clearNameTabs() {
    const box = $("nameTabs");
    if (box) { box.hidden = true; box.innerHTML = ""; }
    nameFilter = "";
    emitNameFilter();
    const cbox = $("catTabs");
    if (cbox) { cbox.hidden = true; cbox.innerHTML = ""; }
    catFilter = "";
  }

  // =========================================================
  //  작품 분류 (분류별로 보기 + 관리자 분류 메뉴)
  // =========================================================

  /// 이 화면에서 실제로 쓰이고 있는 분류들.
  function usedCategories() {
    return [...new Set(scopedItems().map((a) => (a.category || "").trim()).filter(Boolean))];
  }
  /// 메뉴에 보일 분류 = 관리자가 만든 목록 + 실제로 쓰인 분류(직접 넣은 값도 사라지지 않게).
  function allCategories() {
    return [...new Set(categories.concat(usedCategories()))].sort((a, b) => a.localeCompare(b, "ko"));
  }

  // 분류 탭 — 눌러서 그 분류 작품만 보기. 관리자면 분류 추가/이름변경/삭제까지.
  function renderCatTabs() {
    const box = $("catTabs");
    if (!box) return;
    const list = allCategories();
    const hasNone = scopedItems().some((a) => !(a.category || "").trim());
    // 볼 게 없고 관리자도 아니면 줄 자체를 감춘다(학부모 화면이 복잡해지지 않게).
    if (!list.length && !isAdmin) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = "";

    const label = document.createElement("span");
    label.className = "tabs-label";
    label.textContent = "분류";
    box.appendChild(label);

    const mk = (text, val, extraClass) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "name-tab" + (extraClass ? " " + extraClass : "") + (catFilter === val ? " on" : "");
      b.textContent = text;
      if (val !== null) {
        b.addEventListener("click", () => {
          catFilter = val;
          renderCatTabs();
          applyFilters();
        });
      }
      return b;
    };

    box.appendChild(mk("전체", ""));
    list.forEach((c) => box.appendChild(mk(c, c)));
    if (hasNone) box.appendChild(mk("미분류", CAT_NONE));

    if (!isAdmin) return;

    const add = document.createElement("button");
    add.type = "button";
    add.className = "name-tab rename";
    add.textContent = "➕ 분류 추가";
    add.addEventListener("click", addCategory);
    box.appendChild(add);

    // 보이는 작품 전부에 한 번에 분류 달기 — 한 장씩 여는 것보다 빠르다.
    const bulk = document.createElement("button");
    bulk.type = "button";
    bulk.className = "name-tab rename";
    bulk.textContent = "🏷 보이는 작품 분류 지정";
    bulk.addEventListener("click", bulkSetCategory);
    box.appendChild(bulk);

    // 저작 표기(✍️ …)를 보이는 작품에서 한 번에 지우기 — 표기가 있는 작품이 있을 때만.
    if (visibleItems().some((a) => a.authorship)) {
      const clr = document.createElement("button");
      clr.type = "button";
      clr.className = "name-tab rename";
      clr.textContent = "✍️ 표기 일괄 지우기";
      clr.addEventListener("click", bulkClearAuthorship);
      box.appendChild(clr);
    }

    if (catFilter && catFilter !== CAT_NONE) {
      const ren = document.createElement("button");
      ren.type = "button";
      ren.className = "name-tab rename";
      ren.textContent = "✏️ 분류 이름 바꾸기";
      ren.addEventListener("click", () => renameCategory(catFilter));
      box.appendChild(ren);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "name-tab rename";
      del.textContent = "🗑 분류 없애기";
      del.addEventListener("click", () => removeCategory(catFilter));
      box.appendChild(del);
    }
  }

  /// 분류 목록(마스터) 저장. 온라인이면 설정 문서에, 샘플/오프라인이면 이 브라우저에.
  /// 분류 목록은 스프레드시트 "분류" 탭에 둔다 — 모든 반이 같은 목록을 쓰고,
  /// 브라우저를 바꿔도 그대로 보인다.
  /// (예전엔 Firestore school_settings에 뒀는데 규칙이 그 컬렉션을 막고 있어 읽기·쓰기가 모두 실패했고,
  ///  결국 목록이 이 브라우저에만 남아 반마다 달라 보였다.)
  async function saveCategories(next) {
    categories = [...new Set(next.map((c) => String(c || "").trim()).filter(Boolean))];
    if (CLASS_API) {
      try {
        const res = await fetch(CLASS_API, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            action: "setCategories", secret: CFG.classSecret || "",
            adminKey: CFG.adminPassword || "", categories: categories
          })
        }).then((r) => r.json());
        if (!res || !res.ok) throw new Error((res && res.error) || "저장 실패");
      } catch (e) {
        alert("분류 목록을 저장하지 못했어요: " + (e && e.message ? e.message : e));
      }
    } else {
      try { localStorage.setItem("galleryCategories", JSON.stringify(categories)); } catch (_) {}
    }
    renderCatTabs();
  }

  /// "분류" 탭에서 목록을 읽어 온다(모든 반 공용).
  function loadCategories() {
    if (!CLASS_API) { loadLocalCategories(); return Promise.resolve(); }
    return fetch(CLASS_API + "?categories=1")
      .then((r) => r.json())
      .then((d) => {
        if (!d || !d.ok) return;
        categories = (d.categories || []).map((c) => String(c || "").trim()).filter(Boolean);
        refreshUI();
      })
      .catch(() => {});
  }

  function loadLocalCategories() {
    try { categories = JSON.parse(localStorage.getItem("galleryCategories") || "[]") || []; }
    catch (_) { categories = []; }
  }

  function addCategory() {
    const name = (window.prompt("새 분류 이름을 입력하세요.\n예: 크로키 · 명화 따라그리기 · 자유화 · 그림책 삽화", "") || "").trim();
    if (!name) return;
    if (name === CAT_NONE) { alert("그 이름은 쓸 수 없어요."); return; }
    if (allCategories().indexOf(name) >= 0) { alert("이미 있는 분류예요."); return; }
    saveCategories(categories.concat([name]));
  }

  /// 작품 여러 개를 한 번에 고친다. Firestore batch는 한 번에 500개까지라 나눠서 커밋.
  async function batchUpdate(items, data) {
    const CHUNK = 400;
    for (let i = 0; i < items.length; i += CHUNK) {
      const batch = db.batch();
      items.slice(i, i + CHUNK).forEach((a) => batch.update(db.collection(COLLECTION).doc(a.id), data));
      await batch.commit();
    }
  }

  /// 작품 여러 개의 분류를 한 번에 바꾼다.
  async function writeCategory(items, value) {
    items.forEach((a) => { a.category = value; });   // 스냅샷이 오기 전 화면 즉시 반영
    if (usingSample || !db) { renderCatTabs(); applyFilters(); return true; }
    try {
      await batchUpdate(items, { category: value });
      renderCatTabs();
      applyFilters();
      return true;
    } catch (e) {
      alert("분류를 저장하지 못했어요: " + (e && e.message ? e.message : e)
        + "\n\nFirestore 규칙이 쓰기를 막고 있으면 숨김/삭제처럼 쓰기 허용이 필요해요.");
      return false;
    }
  }

  /// 분류 고르기 창 — 번호로 고르거나 새 이름을 그대로 적는다.
  function askCategory(current) {
    const list = allCategories();
    const menu = list.map((c, i) => `${i + 1}. ${c}`).join("\n");
    const ans = window.prompt(
      "분류를 고르세요.\n\n" + (menu ? menu + "\n" : "") + "0. 미분류로 두기\n\n" +
      "번호를 넣거나, 새 분류 이름을 그대로 적으세요.",
      current || "");
    if (ans === null) return null;                 // 취소
    const t = ans.trim();
    if (t === "" || t === "0") return "";          // 미분류
    if (/^\d+$/.test(t)) {
      const pick = list[parseInt(t, 10) - 1];
      if (!pick) { alert("그 번호의 분류가 없어요."); return null; }
      return pick;
    }
    return t;                                      // 새 분류 이름
  }

  /// 지금 화면에 보이는 작품 전부에 분류를 단다.
  async function bulkSetCategory() {
    const list = visibleItems();
    if (!list.length) { alert("지금 보이는 작품이 없어요."); return; }
    const value = askCategory("");
    if (value === null) return;
    const what = value ? `'${value}'` : "미분류";
    if (!confirm(`지금 보이는 작품 ${list.length}개의 분류를 ${what} 으로 바꿀까요?`)) return;
    const ok = await writeCategory(list, value);
    if (ok && value && categories.indexOf(value) < 0) await saveCategories(categories.concat([value]));
  }

  async function renameCategory(oldName) {
    const next = (window.prompt(`'${oldName}' 분류를 어떤 이름으로 바꿀까요?`, oldName) || "").trim();
    if (!next || next === oldName) return;
    const targets = allItems.filter((a) => (a.category || "") === oldName);
    if (!confirm(`분류 이름을 '${oldName}' → '${next}' 로 바꿀까요?\n(작품 ${targets.length}개에 함께 적용돼요)`)) return;
    if (targets.length && !(await writeCategory(targets, next))) return;
    catFilter = next;
    await saveCategories(categories.filter((c) => c !== oldName).concat([next]));
    applyFilters();
  }

  async function removeCategory(name) {
    const targets = allItems.filter((a) => (a.category || "") === name);
    if (!confirm(`'${name}' 분류를 없앨까요?\n작품 ${targets.length}개는 지워지지 않고 '미분류'로 돌아가요.`)) return;
    if (targets.length && !(await writeCategory(targets, ""))) return;
    catFilter = "";
    await saveCategories(categories.filter((c) => c !== name));
    applyFilters();
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
      const reg = regForGroup(school);
      const locked = reg ? !!reg.locked : !!schoolPasswords[school];
      card.innerHTML = `
        <div class="card-thumb">
          ${coverHTML}
          <span class="school-count">${items.length}</span>
          ${locked ? `<span class="school-lock" title="비밀번호 잠김">🔒</span>` : ""}
        </div>
        <div class="card-body">
          <p class="card-student">🏫 ${escapeHtml(school)}</p>
          <p class="card-date">최근 ${formatDate(sorted[0].date)}</p>
          ${isAdmin && !reg ? `<button class="school-pw-btn">${locked ? "🔒 비밀번호 변경/해제" : "🔓 비밀번호 걸기"}</button>` : ""}
          ${isAdmin && reg ? `<p class="school-pw-note">비번은 스프레드시트 “클래스” 탭에서 (${escapeHtml(reg.code || reg.name)})</p>` : ""}
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

  /// 지금 화면에 보이는 작품들(학교·이름·분류·검색 필터를 모두 거친 목록).
  /// 관리자 일괄 작업도 이 목록을 그대로 쓴다 — 보이는 것과 바뀌는 것이 어긋나지 않게.
  function visibleItems() {
    const q = searchInput.value.trim().toLowerCase();
    let list = scopedItems();
    if (nameFilter) list = list.filter((a) => (a.student || "") === nameFilter);
    if (catFilter === CAT_NONE) list = list.filter((a) => !(a.category || "").trim());
    else if (catFilter) list = list.filter((a) => (a.category || "") === catFilter);
    if (q) list = list.filter((a) => a.student.toLowerCase().includes(q) || a.title.toLowerCase().includes(q));
    return list;
  }

  function applyFilters() {
    const sort = sortSelect.value;
    const list = visibleItems().slice();
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
          ${item.category ? `<p class="card-cat">🏷 ${escapeHtml(item.category)}</p>` : ""}
          ${item.title ? `<p class="card-title">${escapeHtml(item.title)}</p>` : ""}
          <p class="card-date">${formatDate(item.date)}</p>
        </div>`;
      // ✍️ 저작 구분(이야기·그림 학생 직접)은 목록에서 빼고, 작품을 크게 볼 때(모달)만 보여준다.
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

  /// 작품 창의 설명줄과 관리자 버튼 라벨을 지금 값으로 다시 그린다.
  /// (열 때 / 분류 바꿀 때 / 저작 표기 바꿀 때 같은 줄을 쓰므로 한 곳으로 모음)
  function refreshModalInfo(item) {
    $("modalMeta").textContent = [
      item.school,
      item.category ? "🏷 " + item.category : "",
      typeLabel(item),
      formatDate(item.date),
      authorshipText(item)
    ].filter(Boolean).join(" · ");
    const catBtn = $("catBtn");
    if (catBtn) catBtn.textContent = item.category ? "🏷 " + item.category : "🏷 분류 지정";
    const authBtn = $("authBtn");
    if (authBtn) authBtn.textContent = item.authorship ? "✍️ 표기 바꾸기" : "✍️ 저작 표기";
  }

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
    refreshModalInfo(item);
    // 다른 작품을 열면 고르기 창은 접힌 상태로 시작
    if ($("catPicker")) $("catPicker").hidden = true;
    if ($("authPicker")) $("authPicker").hidden = true;

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

  // 분류 지정 (관리자) — 작품 창 안에서 눌러서 고른다.
  // 폰에서 번호를 받아 적는 입력창은 불편해서, 분류를 칩으로 깔아 한 번에 고르게 한다.
  $("catBtn").addEventListener("click", () => {
    const picker = $("catPicker");
    if (!picker || !currentItem) return;
    if (!picker.hidden) { picker.hidden = true; return; }   // 한 번 더 누르면 닫기
    if ($("authPicker")) $("authPicker").hidden = true;     // 고르기 창은 한 번에 하나만
    renderCatPicker();
    picker.hidden = false;
  });

  function renderCatPicker() {
    const box = $("catPickerList");
    if (!box || !currentItem) return;
    const cur = currentItem.category || "";
    box.innerHTML = "";

    const mk = (text, val, extra) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "name-tab" + (extra ? " " + extra : "") + (val !== null && cur === val ? " on" : "");
      b.textContent = text;
      b.addEventListener("click", () => pickCategoryForCurrent(val));
      return b;
    };

    allCategories().forEach((c) => box.appendChild(mk(c, c)));
    box.appendChild(mk("미분류로", ""));
    box.appendChild(mk("➕ 새 분류", null, "rename"));
  }

  /// 작품 창에서 고른 분류를 그 작품에 바로 적용. val === null 이면 새 이름을 묻는다.
  async function pickCategoryForCurrent(val) {
    if (!currentItem) return;
    const item = currentItem;
    let value = val;
    if (value === null) {
      value = (window.prompt("새 분류 이름을 입력하세요.\n예: 크로키 · 명화 따라그리기 · 자유화", "") || "").trim();
      if (!value) return;
    }
    const ok = await writeCategory([item], value);
    if (!ok) return;
    if (value && categories.indexOf(value) < 0) await saveCategories(categories.concat([value]));
    $("catPicker").hidden = true;
    refreshModalInfo(item);
  }

  // =========================================================
  //  저작 표기 (✍️ 이야기·그림 학생 직접 / 🧚 밑그림 힌트 사용)
  // =========================================================

  /// 고를 수 있는 표기 3가지. value 가 작품 문서의 authorship 필드에 그대로 들어간다.
  const AUTHORSHIP_CHOICES = [
    { label: "✍️ 학생 직접",            value: { used_ai_hint: false } },
    { label: "✍️ 학생 직접 · 🧚 힌트 사용", value: { used_ai_hint: true } },
    { label: "표기 없음",                value: null }
  ];

  /// 지금 작품이 위 3가지 중 무엇인지.
  function authorshipKey(a) {
    if (!a) return "none";
    return a.used_ai_hint === true ? "hint" : "self";
  }
  function choiceKey(v) {
    if (!v) return "none";
    return v.used_ai_hint === true ? "hint" : "self";
  }

  $("authBtn").addEventListener("click", () => {
    const picker = $("authPicker");
    if (!picker || !currentItem) return;
    if (!picker.hidden) { picker.hidden = true; return; }   // 한 번 더 누르면 닫기
    if ($("catPicker")) $("catPicker").hidden = true;       // 고르기 창은 한 번에 하나만
    renderAuthPicker();
    picker.hidden = false;
  });

  function renderAuthPicker() {
    const box = $("authPickerList");
    if (!box || !currentItem) return;
    const cur = authorshipKey(currentItem.authorship);
    box.innerHTML = "";
    AUTHORSHIP_CHOICES.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "name-tab" + (choiceKey(c.value) === cur ? " on" : "");
      b.textContent = c.label;
      b.addEventListener("click", () => pickAuthorship(c.value));
      box.appendChild(b);
    });
  }

  /// 지금 보이는 작품 전부에서 저작 표기를 지운다.
  /// (한 장씩 열지 않고 '✍️ 이야기·그림 학생 직접' 줄을 목록에서 걷어낼 때)
  async function bulkClearAuthorship() {
    const targets = visibleItems().filter((a) => a.authorship);
    if (!targets.length) { alert("지금 보이는 작품에는 저작 표기가 없어요."); return; }
    if (!confirm("지금 보이는 작품 " + targets.length + "개에서 '✍️ 이야기·그림 학생 직접' 표기를 지울까요?\n"
      + "표기만 사라지고 작품은 그대로예요.")) return;

    const before = targets.map((a) => a.authorship);
    targets.forEach((a) => { a.authorship = null; });   // 화면 먼저 반영
    if (!(usingSample || !db)) {
      try {
        await batchUpdate(targets, { authorship: null });
      } catch (e) {
        targets.forEach((a, i) => { a.authorship = before[i]; });   // 실패하면 되돌린다
        alert("표기를 지우지 못했어요: " + (e && e.message ? e.message : e));
        return;
      }
    }
    renderCatTabs();
    applyFilters();
  }

  async function pickAuthorship(value) {
    if (!currentItem) return;
    const item = currentItem;
    const before = item.authorship;
    item.authorship = value;                       // 스냅샷 전 화면 즉시 반영
    if (!(usingSample || !db)) {
      try {
        await db.collection(COLLECTION).doc(item.id).update({ authorship: value });
      } catch (e) {
        item.authorship = before;                  // 실패하면 되돌린다
        alert("저작 표기를 저장하지 못했어요: " + (e && e.message ? e.message : e)
          + "\n\nFirestore 규칙이 쓰기를 막고 있으면 숨김/삭제처럼 쓰기 허용이 필요해요.");
        return;
      }
    }
    $("authPicker").hidden = true;
    refreshModalInfo(item);
    applyFilters();                                // 카드의 표기도 같이 갱신
  }

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
    // 별도 스크립트(home-rails.js: 그림책 레일)도 관리자 상태를 알도록 알린다.
    window.galleryAdmin = on;
    document.dispatchEvent(new CustomEvent("gallery-admin", { detail: on }));
    window.galleryClass = null;     // 관리자 여부가 바뀌었으니 반 정보를 다시 알린다(사진 줄이 따라온다)
    if (on) syncClassesToSheet();   // 새로 만든 반을 "클래스" 시트에 자동 등록
    refreshUI();
  }

  // =========================================================
  //  이벤트 + 유틸
  // =========================================================
  searchInput.addEventListener("input", debounce(() => {
    if (searchInput.value.trim() && nameFilter) { nameFilter = ""; emitNameFilter(); renderNameTabs(); }
    applyFilters();
  }, 200));
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
  loadClassRegistry();   // 반 이름·잠금 여부·사진폴더명(스프레드시트 "클래스" 탭)
  loadCategories();      // 작품 분류 목록(스프레드시트 "분류" 탭 — 모든 반 공용)

  if (firebaseUsable()) {
    startFirebase();
  } else {
    loadSample();
  }
})();
