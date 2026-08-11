/* =========================================================
   Artable 갤러리 — 클래스 안의 가로 줄(레일)
     클래스 카드 → (비밀번호) → 📚 그림책 · 🎨 우리 그림 · 📷 수업 모습

   홈(클래스 카드 나열)은 기존 script.js 그대로 두고,
   클래스로 들어갔을 때만 작품 그리드 위/아래에 레일을 붙인다.
   가운데 '우리 그림'은 기존 그리드를 그대로 쓴다(검색·정렬·모달·관리자 기능 유지).
   ========================================================= */
(function () {
  "use strict";

  // 📷 수업 모습 사진을 가져올 웹앱.
  // config.js 의 photoApi 가 있으면 그걸 쓰고(갤러리 전용 · 리포트와 별개 루트),
  // 없으면 기존 용역 리포트 웹앱을 그대로 본다.
  var REPORT_API = (window.GALLERY_CONFIG || {}).photoApi
    || "https://script.google.com/macros/s/AKfycbyV5LibT5DHLAIwujt8u8yjkyBtxpzSMF5T2aepcPdbgvQITCKc7kou4mlqcNxIvLKZ/exec";
  // 온라인 발행 그림책의 출처(뷰어와 동일한 GAS 웹앱). ?class=<반코드> → {ok, books:[{bookId,title,student,cover}]}
  var BOOKS_API = "https://script.google.com/macros/s/AKfycbzBg9ghzZSLv0J3MlUWMNVscBQuKVd2JgYS-HyiBAuqzPEh5qbGCUW9o_PorKOILx4/exec";
  var VIEWER = "viewer.html";

  var $ = function (id) { return document.getElementById(id); };

  // 클래스 이름 → 그 반의 반코드 모음 (그림책을 반과 이어 붙이는 데 쓴다)
  var codesByClass = {};
  var reportData = null;   // 비밀번호를 통과한 뒤의 사진 트리
  var currentClass = "";
  var isAdmin = !!window.galleryAdmin;   // script.js가 관리자 모드일 때 알려줌(그림책 삭제 버튼)
  var bookRailRef = null;                // 관리자 전환 시 그림책 레일만 다시 그리기 위한 참조
  var photoRailRef = null;               // 반이 바뀌면 사진 레일을 다시 채우기 위한 참조
  var studentFilter = "";                // 이름 탭에서 고른 학생('' = 전체) — 그림책도 같이 거른다
  // 지금 열린 반(스프레드시트 "클래스" 탭) — { name, code, org, pw }.
  //   · org  : 드라이브의 기관 폴더 이름. 반 제목과 폴더 이름이 달라도 사진이 이어진다.
  //   · pw   : 반 비번을 통과했으면 그 비번으로 사진도 바로 열어 본다(두 번 묻지 않게).
  var classInfo = window.galleryClass || null;

  /// 가로로 부드럽게 옮긴다.
  /// scroll-behavior:smooth 와 scroll-snap 을 같이 쓰면 코드로 건 스크롤이 스냅 엔진에
  /// 취소되는 브라우저가 있어 직접 한 프레임씩 그린다. 프레임이 안 도는 상황(백그라운드 탭)
  /// 에서는 즉시 옮겨 '눌러도 안 움직이는' 상태가 되지 않게 한다.
  function glide(box, target, done) {
    var keepSnap = box.style.scrollSnapType, keepBehav = box.style.scrollBehavior;
    box.style.scrollSnapType = "none"; box.style.scrollBehavior = "auto";
    function finish() {
      box.scrollLeft = target;
      box.style.scrollSnapType = keepSnap; box.style.scrollBehavior = keepBehav;
      if (done) done();
    }
    if (document.hidden || typeof requestAnimationFrame !== "function") { finish(); return; }
    var guard = setTimeout(finish, 900);
    var from = box.scrollLeft, dist = target - from, t0 = null, ms = 320;
    function frame(t) {
      if (t0 === null) t0 = t;
      var k = Math.min(1, (t - t0) / ms);
      var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      box.scrollLeft = from + dist * e;
      if (k < 1) requestAnimationFrame(frame);
      else { clearTimeout(guard); finish(); }
    }
    requestAnimationFrame(frame);
  }

  function makeRail(id, icon, title) {
    var sec = document.createElement("section");
    sec.className = "rail"; sec.id = id; sec.hidden = true;
    sec.innerHTML =
      '<div class="rail-head">' +
        '<h2 class="rail-title">' + icon + " " + title + "</h2>" +
        '<span class="rail-cnt"></span>' +
        '<button class="rail-arrow" type="button" aria-label="이전">‹</button>' +
        '<button class="rail-arrow" type="button" aria-label="다음">›</button>' +
      "</div>" +
      '<div class="rail-track"></div>';
    var track = sec.querySelector(".rail-track");
    var arrows = sec.querySelectorAll(".rail-arrow");
    function sync() {
      var end = track.scrollWidth - track.clientWidth - 2;
      arrows[0].disabled = track.scrollLeft <= 2;
      arrows[1].disabled = track.scrollLeft >= end;
      var hide = track.scrollWidth <= track.clientWidth + 2;   // 한 화면에 다 들어오면 숨긴다
      arrows[0].style.display = arrows[1].style.display = hide ? "none" : "";
    }
    function page(dir) {
      var max = track.scrollWidth - track.clientWidth;
      glide(track, Math.max(0, Math.min(max, track.scrollLeft + dir * track.clientWidth)), sync);
    }
    arrows[0].addEventListener("click", function () { page(-1); });
    arrows[1].addEventListener("click", function () { page(1); });
    track.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    return {
      section: sec, track: track, sync: sync,
      setCount: function (t) { sec.querySelector(".rail-cnt").textContent = t || ""; }
    };
  }

  function tile(imgUrl, line1, line2, onClick, isVideo, onDelete) {
    var el = document.createElement("div");
    el.className = "rail-tile";
    el.innerHTML =
      '<div class="rail-thumb">' +
        (imgUrl ? '<img loading="lazy" alt="">' : '<div class="rail-noimg">🖼</div>') +
        (isVideo ? '<span class="rail-play">▶</span>' : "") +
        (onDelete ? '<button class="rail-del" type="button" title="삭제" aria-label="삭제">🗑</button>' : "") +
      "</div>" +
      '<p class="rail-l1"></p>' + (line2 ? '<p class="rail-l2"></p>' : "");
    if (imgUrl) {
      var im = el.querySelector("img");
      im.src = imgUrl;
      im.addEventListener("error", function () { im.style.visibility = "hidden"; });
    }
    el.querySelector(".rail-l1").textContent = line1 || "";
    if (line2) el.querySelector(".rail-l2").textContent = line2;
    if (onClick) el.addEventListener("click", onClick);
    if (onDelete) {
      el.querySelector(".rail-del").addEventListener("click", function (e) {
        e.stopPropagation();   // 타일 클릭(뷰어 열기)과 분리
        onDelete();
      });
    }
    return el;
  }

  function db() { try { return firebase.firestore(); } catch (e) { return null; } }

  // ---------- 반코드 모으기 ----------

  /// 작품 문서에서 '클래스 이름 → 반코드들'을 만들어 둔다.
  /// (홈 카드의 이름은 학교명 → 없으면 반이름 순으로 정해지므로 같은 규칙을 쓴다)
  function loadClassCodes() {
    var d = db();
    if (!d) return Promise.resolve();
    var CFG = window.GALLERY_CONFIG || {};
    return d.collection(CFG.collection || "submissions").limit(600).get().then(function (snap) {
      snap.forEach(function (doc) {
        var a = doc.data() || {};
        var name = a.school_name || a.class_name || a.className || a.class_code || "";
        var code = a.class_code || a.classCode || "";
        if (!name || !code) return;
        (codesByClass[name] = codesByClass[name] || {})[code] = true;
      });
    }).catch(function () {});
  }

  // 반이름 → 발행 그림책 목록 캐시(GAS 재호출 줄이기)
  var booksByClass = {};
  var lastBooksLoadFailed = false;   // 마지막 로드에 실패가 섞였는지(빈 결과 판정용)

  // 공유 링크(?class=반코드)로 들어오면 그 코드로 즉시 조회한다 — Firestore 로드를 기다리지 않게.
  var URL_CLASS = "";
  try { URL_CLASS = (new URLSearchParams(location.search).get("class") || "").trim(); } catch (e) {}

  // 반코드를 아는 순간(페이지 로드 직후) 그림책 요청을 미리 쏘아 둔다.
  // 화면이 그려질 때쯤엔 응답이 도착해 있어 기다림이 거의 없다.
  var prefetchByCode = {};
  function fetchBooksByCode(code) {
    if (!prefetchByCode[code]) {
      prefetchByCode[code] = fetch(BOOKS_API + "?class=" + encodeURIComponent(code))
        .then(function (r) { return r.json(); });
    }
    return prefetchByCode[code].then(
      function (j) { return j; },
      function (err) { delete prefetchByCode[code]; throw err; }   // 실패한 프리페치는 버리고 다음에 다시
    );
  }
  if (URL_CLASS) fetchBooksByCode(URL_CLASS).catch(function () {});

  // 브라우저에 마지막 목록을 저장해 두면 다음 방문(같은 기기)에서 즉시 그려진다.
  function booksCacheKey(className) { return "railBooks:" + className; }
  function readBooksCache(className) {
    try { return JSON.parse(localStorage.getItem(booksCacheKey(className)) || "null"); }
    catch (e) { return null; }
  }
  function writeBooksCache(className, books) {
    try { localStorage.setItem(booksCacheKey(className), JSON.stringify(books)); } catch (e) {}
  }

  /// 이 반의 온라인 발행 그림책을 GAS에서 가져온다(뷰어와 같은 출처).
  /// Firestore storybooks 문서는 bookId가 비어 있어(발행 시 되쓰지 않음) 쓰지 않는다.
  /// 반이 여러 반코드를 가질 수 있어(codesByClass) 코드별로 모아 bookId로 중복 제거한다.
  function loadBooksForClass(className) {
    lastBooksLoadFailed = false;
    if (booksByClass[className]) return Promise.resolve(booksByClass[className]);
    var codes = Object.keys(codesByClass[className] || {});
    // 코드 대신 반이름을 코드로 쓰는 반도 있어 함께 시도.
    if (codes.indexOf(className) < 0) codes = codes.concat([className]);
    // 공유 링크의 반코드는 Firestore 로드 전에도 바로 쓴다(첫 화면 지연 제거).
    if (URL_CLASS && codes.indexOf(URL_CLASS) < 0) codes.push(URL_CLASS);
    if (!codes.length) return Promise.resolve([]);
    var failed = false;   // GAS가 잠깐 실패한 건지, 정말 책이 없는 건지 구분한다
    return Promise.all(codes.map(function (code) {
      return fetchBooksByCode(code)
        .then(function (j) {
          if (j && j.ok) return j.books || [];
          failed = true; return [];
        })
        .catch(function () { failed = true; return []; });
    })).then(function (lists) {
      var seen = {}, out = [];
      lists.forEach(function (books) {
        (books || []).forEach(function (b) {
          if (!b.bookId || seen[b.bookId]) return;
          seen[b.bookId] = true;
          out.push(b);
        });
      });
      // 실패 섞인 빈 결과는 캐시하지 않는다 — 다음 렌더에서 다시 시도해 깜빡임을 막는다.
      lastBooksLoadFailed = failed;
      if (out.length || !failed) booksByClass[className] = out;
      return out;
    });
  }

  // ---------- 📚 그림책 ----------

  /// 그림책 전용 타일 — 원본 첫 장은 [뒤표지|앞표지]가 붙은 펼침 이미지라,
  /// 뷰어의 1페이지처럼 오른쪽 절반(앞표지)만 보여준다. 세로 이미지는 통째로.
  function bookTile(coverUrl, line1, line2, onClick, onDelete) {
    var el = document.createElement("div");
    el.className = "rail-tile";
    el.innerHTML =
      '<div class="rail-thumb">' +
        '<div class="rail-cover"></div>' +
        (onDelete ? '<button class="rail-del" type="button" title="삭제" aria-label="삭제">🗑</button>' : "") +
      "</div>" +
      '<p class="rail-l1"></p>' + (line2 ? '<p class="rail-l2"></p>' : "");
    var cov = el.querySelector(".rail-cover");
    if (coverUrl) {
      cov.style.backgroundImage = 'url("' + coverUrl + '")';
      var probe = new Image();
      probe.onload = function () {
        if (probe.naturalWidth > probe.naturalHeight * 1.15) cov.classList.add("spread");
      };
      probe.src = coverUrl;
    }
    el.querySelector(".rail-l1").textContent = line1 || "";
    if (line2) el.querySelector(".rail-l2").textContent = line2;
    if (onClick) el.addEventListener("click", onClick);
    if (onDelete) {
      el.querySelector(".rail-del").addEventListener("click", function (e) {
        e.stopPropagation();
        onDelete();
      });
    }
    return el;
  }

  function renderBooks(rail, className, mine) {
    // 이름 탭에서 학생을 골랐으면 그 학생 책만.
    if (studentFilter) {
      mine = mine.filter(function (b) { return (b.student || "").trim() === studentFilter; });
    }
    if (!mine.length) {
      rail.track.innerHTML = "";
      rail.setCount("");
      rail.section.hidden = true;   // 이 학생 책이 없으면 줄을 감춘다
      return;
    }
    rail.track.innerHTML = "";
    mine.forEach(function (b) {
      var title = (b.title || "").trim() || "그림책";
      var del = isAdmin ? function () { deleteBookOnline(b, rail, className); } : null;
      rail.track.appendChild(bookTile(b.cover, title, b.student || "", function () {
        location.href = VIEWER + "?book=" + encodeURIComponent(b.bookId);
      }, del));
    });
    rail.setCount(mine.length + "권" + (isAdmin ? " · 관리자" : ""));
    rail.section.hidden = false;
    rail.sync();
  }

  /// 데이터가 오기 전 빈 책 모양(스켈레톤)을 먼저 그려 자리를 잡아둔다.
  function renderBookSkeleton(rail) {
    rail.track.innerHTML = "";
    for (var i = 0; i < 4; i++) {
      var el = document.createElement("div");
      el.className = "rail-tile rail-skel";
      el.innerHTML = '<div class="rail-thumb"><div class="rail-skel-box"></div></div>'
        + '<p class="rail-l1 rail-skel-line"></p>';
      rail.track.appendChild(el);
    }
    rail.setCount("불러오는 중…");
    rail.section.hidden = false;
  }

  /// 이 반 그림책의 지은이 이름을 이름 탭(script.js)에 알린다.
  /// 작품(submissions)은 없고 그림책만 만든 아이는 이름 탭에서 통째로 빠지던 문제를 막는다.
  function emitBookNames(books) {
    var seen = {}, names = [];
    (books || []).forEach(function (b) {
      var n = String((b && b.student) || "").trim();
      if (!n || seen[n]) return;
      seen[n] = true; names.push(n);
    });
    document.dispatchEvent(new CustomEvent("gallery-booknames", { detail: names }));
  }

  function fillBooks(rail, className) {
    // 지난 방문에 저장해 둔 목록이 있으면 먼저 그려서(즉시 표시) 서버 응답을 기다리지 않는다.
    // 저장본조차 없으면 스켈레톤으로 자리부터 잡는다 — 늦게 불쑥 생기며 화면이 밀리지 않게.
    var cached = readBooksCache(className);
    if (!rail.track.childElementCount) {
      if (cached && cached.length) renderBooks(rail, className, cached);
      else renderBookSkeleton(rail);
    }
    if (cached && cached.length) emitBookNames(cached);   // 저장본으로 이름 탭 먼저 채우기

    loadBooksForClass(className).then(function (mine) {
      if (mine.length || !lastBooksLoadFailed) emitBookNames(mine);   // 일시 실패면 저장본 이름 유지
      var hasReal = rail.track.childElementCount && !rail.track.querySelector(".rail-skel");
      if (!mine.length) {
        if (!lastBooksLoadFailed) {
          // 진짜 빈 반(책이 다 지워진 경우) — 저장본도 지우고 줄을 감춘다.
          try { localStorage.removeItem(booksCacheKey(className)); } catch (e) {}
          rail.track.innerHTML = "";
          rail.section.hidden = true;
        } else if (!hasReal) {
          // 일시 실패 + 스켈레톤뿐 → 감춘다(다음 렌더에서 재시도).
          rail.track.innerHTML = "";
          rail.section.hidden = true;
        }
        return;
      }
      writeBooksCache(className, mine);
      renderBooks(rail, className, mine);
    });
  }

  /// 관리자: 온라인 그림책 삭제(GAS deleteBook → 드라이브 폴더 휴지통 + 시트 행 제거).
  /// 업로드 secret이 아닌 별도 관리자 키(config.adminPassword)로 인증한다.
  function deleteBookOnline(book, rail, className) {
    var name = (book.title || "").trim() || "이 그림책";
    if (!window.confirm("‘" + name + "’ 을(를) 온라인 그림책에서 삭제할까요?\n드라이브 휴지통으로 이동해요(30일 안에 복구 가능).")) return;
    var CFG = window.GALLERY_CONFIG || {};
    fetch(BOOKS_API, {
      method: "POST",
      // 프리플라이트 없이(GAS 단순요청) 보내려고 text/plain 사용.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "deleteBook", adminKey: CFG.adminPassword || "", bookId: book.bookId })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) {
          window.alert("삭제하지 못했어요" + (d && d.error ? " (" + d.error + ")" : "") +
            ".\n\n그림책 백엔드(Apps Script)를 최신 코드로 재배포했는지 확인해 주세요.");
          return;
        }
        if (booksByClass[className]) {
          booksByClass[className] = booksByClass[className].filter(function (x) { return x.bookId !== book.bookId; });
          writeBooksCache(className, booksByClass[className]);   // 브라우저 저장본도 갱신 — 새로고침 때 안 되살아나게
        }
        prefetchByCode = {};                                     // 미리 받아둔 응답도 버린다
        fillBooks(rail, className);
      })
      .catch(function () { window.alert("삭제 요청에 실패했어요(연결 오류)."); });
  }

  // ---------- 📷 수업 모습 ----------

  function fillPhotos(rail, className) {
    rail.track.innerHTML = "";
    var old = rail.section.querySelector(".rail-gate, .rail-days");
    while (old) { old.remove(); old = rail.section.querySelector(".rail-gate, .rail-days"); }
    rail.section.hidden = false;

    if (reportData) { renderPhotos(rail, className); return; }

    // 반 비번을 이미 통과했다면 그 비번으로 조용히 열어 본다(부모님께 두 번 묻지 않게).
    var classPw = (classInfo && classInfo.pw) || "";

    var gate = document.createElement("div");
    gate.className = "rail-gate";
    gate.innerHTML =
      "<p>수업 사진은 아이들 얼굴이 담겨 있어 비밀번호를 넣어야 보여요.</p>" +
      '<div class="rail-gate-row">' +
        '<input type="password" placeholder="비밀번호" autocomplete="current-password">' +
        "<button type=\"button\">열기</button>" +
      "</div><span class=\"rail-gate-err\"></span>";
    rail.section.insertBefore(gate, rail.track);

    var input = gate.querySelector("input"), btn = gate.querySelector("button"),
        err = gate.querySelector(".rail-gate-err");
    var saved = classPw || localStorage.getItem("reportPw");
    if (saved) { if (!classPw) input.value = saved; open(saved, true); }
    btn.addEventListener("click", function () { open(input.value.trim(), false); });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") btn.click(); });

    function open(pw, quiet) {
      if (!pw) return;
      if (!quiet) err.textContent = "여는 중…";
      fetch(REPORT_API, {
        method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
        // class 를 같이 보내면 그 반 비번으로도 열린다(그 반 사진만 내려온다).
        body: JSON.stringify({
          action: "reportTree", secret: "artclasshub-2026", pw: pw,
          "class": (classInfo && (classInfo.code || classInfo.name)) || className
        })
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.ok) {
            if (pw !== classPw) localStorage.removeItem("reportPw");
            err.textContent = quiet ? "" : (d.message || "열지 못했어요.");
            return;
          }
          if (pw !== classPw) localStorage.setItem("reportPw", pw);
          reportData = sanitizeDates(d.dates || []);
          gate.remove();
          renderPhotos(rail, className);
        })
        .catch(function () { err.textContent = "연결에 실패했어요."; });
    }
  }

  /// 이름이 00_ 로 시작하는 폴더(00_inbox, 00_삭제요망 등 작업/임시 폴더)는 보고에서 뺀다.
  function isHiddenFolder(name) {
    return /^00_/.test(String(name == null ? "" : name).trim());
  }

  /// 갤러리에 보여줄 수업(프로그램)인지 — config.js의 photoPrograms 기준.
  /// 폴더 이름에 그 말이 들어간 수업만 통과(예: ["창의미술"] → 도자기·서예 제외).
  /// 비어 있으면 전체 통과. 날짜 탭의 개수도 이 필터를 거친 뒤 세진다.
  function programAllowed(title) {
    var allow = (window.GALLERY_CONFIG || {}).photoPrograms;
    if (!allow || !allow.length) return true;
    var t = String(title == null ? "" : title);
    for (var i = 0; i < allow.length; i++) {
      if (allow[i] && t.indexOf(allow[i]) >= 0) return true;
    }
    return false;
  }

  function sanitizeDates(dates) {
    return (dates || [])
      .filter(function (day) { return !isHiddenFolder(day.folder); })
      .map(function (day) {
        var orgs = (day.orgs || [])
          .filter(function (o) { return !isHiddenFolder(o.org); })
          .map(function (o) {
            o.programs = (o.programs || []).filter(function (pr) {
              return !isHiddenFolder(pr.title) && programAllowed(pr.title);
            });
            return o;
          })
          .filter(function (o) { return (o.programs || []).length; });
        day.orgs = orgs;
        return day;
      })
      .filter(function (day) { return (day.orgs || []).length; });
  }

  function dparts(f) {
    var g = String(f).replace(/[^0-9]/g, "");
    if (g.length !== 8) return { m: String(f), y: "" };
    return { m: (+g.substr(4, 2)) + "/" + (+g.substr(6, 2)), y: g.substr(0, 4) };
  }

  /// 이 클래스(기관)에 해당하는 날짜만 골라 날짜 카드 + 사진 한 줄로.
  function renderPhotos(rail, className) {
    // 같은 날짜(folder)가 여러 번 와도 한 줄만: folder로 묶어 프로그램만 합친다.
    // (GAS가 같은 날짜를 두 번 돌려주면 날짜 카드가 두 줄로 중복되던 버그 방지)
    // 드라이브의 기관 폴더 이름이 반 제목과 다를 수 있다(예: 반 '온마을학교 2기' ↔ 폴더 '부일초등학교').
    // 스프레드시트 "클래스" 탭 D열(사진폴더명)에 적어 두면 그 이름으로도 이어 준다.
    var org = (classInfo && classInfo.org) || className;
    var byFolder = {}, days = [];
    (reportData || []).forEach(function (day) {
      var orgs = day.orgs.filter(function (o) { return o.org === org || o.org === className; });
      if (!orgs.length) return;
      if (byFolder[day.folder]) {
        byFolder[day.folder].orgs = byFolder[day.folder].orgs.concat(orgs);
      } else {
        var entry = { folder: day.folder, orgs: orgs };
        byFolder[day.folder] = entry;
        days.push(entry);
      }
    });

    // 이미 그려둔 날짜줄이 있으면 지우고 새로 그린다(중복 삽입 방지).
    var stale = rail.section.querySelector(".rail-days");
    while (stale) { stale.remove(); stale = rail.section.querySelector(".rail-days"); }

    if (!days.length) {
      rail.track.innerHTML = "";
      rail.setCount("");
      rail.section.hidden = true;   // 이 반 사진이 없으면 줄 자체를 감춘다
      return;
    }

    var bar = document.createElement("div");
    bar.className = "rail-days";
    rail.section.insertBefore(bar, rail.track);
    var pick = days[0].folder;

    function draw() {
      bar.innerHTML = "";
      days.forEach(function (day) {
        var p = dparts(day.folder), n = 0;
        day.orgs.forEach(function (o) { o.programs.forEach(function (pr) { n += pr.photos.length; }); });
        var c = document.createElement("button");
        c.type = "button";
        c.className = "rail-day" + (day.folder === pick ? " on" : "");
        c.innerHTML = '<span class="y">' + p.y + '</span><span class="d">' + p.m
          + '</span><span class="n">' + n + "개</span>";
        c.addEventListener("click", function () { pick = day.folder; draw(); });
        bar.appendChild(c);
      });

      var day = days.filter(function (d) { return d.folder === pick; })[0];
      var shots = [];
      day.orgs.forEach(function (o) {
        o.programs.forEach(function (pr) {
          pr.photos.forEach(function (ph) { shots.push({ ph: ph, org: o.org, prog: pr.title }); });
        });
      });
      rail.track.innerHTML = "";
      shots.forEach(function (s, i) {
        rail.track.appendChild(tile(s.ph.thumb, s.prog, s.ph.kind === "video" ? "영상" : "",
          function () { lightbox(shots, i); }, s.ph.kind === "video"));
      });
      rail.setCount(shots.length + "개");
      rail.sync();
    }
    draw();
  }

  // ---------- 사진 크게 보기 ----------
  var box, boxImg, boxVid, boxCap, SHOTS = [], AT = 0;
  function ensureBox() {
    if (box) return;
    box = document.createElement("div");
    box.className = "rail-box";
    box.innerHTML = '<span class="x">×</span><span class="nav prev">‹</span>'
      + '<img alt=""><iframe allow="autoplay; fullscreen" allowfullscreen hidden></iframe>'
      + '<span class="nav next">›</span><div class="cap"></div>';
    document.body.appendChild(box);
    boxImg = box.querySelector("img"); boxVid = box.querySelector("iframe"); boxCap = box.querySelector(".cap");
    box.querySelector(".x").addEventListener("click", close);
    box.querySelector(".prev").addEventListener("click", function (e) { e.stopPropagation(); step(-1); });
    box.querySelector(".next").addEventListener("click", function (e) { e.stopPropagation(); step(1); });
    box.addEventListener("click", function (e) { if (e.target === box) close(); });
    document.addEventListener("keydown", function (e) {
      if (!box || box.style.display !== "flex") return;
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") step(1);
      if (e.key === "ArrowLeft") step(-1);
    });
  }
  function lightbox(shots, at) { ensureBox(); SHOTS = shots; AT = at; show(); }
  function show() {
    var s = SHOTS[AT];
    if (s.ph.kind === "video") {
      boxImg.hidden = true; boxImg.removeAttribute("src");
      boxVid.hidden = false; boxVid.src = s.ph.full;
    } else {
      boxVid.hidden = true; boxVid.removeAttribute("src");   // 재생 중이던 영상을 확실히 멈춘다
      boxImg.hidden = false; boxImg.src = s.ph.full;
    }
    boxCap.textContent = s.org + " · " + s.prog + "  (" + (AT + 1) + "/" + SHOTS.length + ")";
    box.style.display = "flex";
  }
  function step(d) { AT = (AT + d + SHOTS.length) % SHOTS.length; show(); }
  function close() {
    box.style.display = "none";
    boxVid.removeAttribute("src"); boxImg.removeAttribute("src");
  }

  // ---------- 조립 ----------
  function init() {
    var galleryEl = $("gallery");
    var head = $("schoolHeader");
    var titleEl = $("schoolTitle");
    if (!galleryEl || !head) return;

    var bookRail = makeRail("railBooks", "📚", "그림책");
    bookRailRef = bookRail;
    var photoRail = makeRail("railPhotos", "📷", "수업 모습");
    photoRailRef = photoRail;

    // 반이 열리면(비번 통과 등) 그 반 비번·폴더 이름으로 사진을 다시 열어 본다.
    document.addEventListener("gallery-class", function (e) {
      var next = (e && e.detail) || null;
      var was = (classInfo && classInfo.pw) || "";
      classInfo = next;
      if (((next && next.pw) || "") !== was) {
        reportData = null;                                   // 비번이 바뀌면 사진도 다시 받는다
        if (currentClass && photoRailRef) fillPhotos(photoRailRef, currentClass);
      }
    });

    // 관리자 모드 on/off 시 그림책 레일만 다시 그려 삭제 버튼을 붙이거나 없앤다.
    document.addEventListener("gallery-admin", function (e) {
      isAdmin = !!(e && e.detail);
      if (currentClass && bookRailRef) fillBooks(bookRailRef, currentClass);
    });
    // 이름 탭에서 학생을 고르면 그림책도 그 학생 것만 보여준다.
    document.addEventListener("gallery-namefilter", function (e) {
      studentFilter = String((e && e.detail) || "").trim();
      if (currentClass && bookRailRef) fillBooks(bookRailRef, currentClass);
    });
    var artHead = document.createElement("h2");
    artHead.className = "rail-title rail-standalone";
    artHead.textContent = "🎨 우리 그림";
    artHead.hidden = true;

    galleryEl.parentNode.insertBefore(bookRail.section, galleryEl);
    galleryEl.parentNode.insertBefore(artHead, galleryEl);
    // '작품이 없어요' 안내는 그리드가 있던 자리(🎨 우리 그림 아래)로 옮긴다.
    // 안 그러면 그림이 없는 반에서 안내문이 📚 그림책 위로 올라와 줄 순서가 뒤바뀐 것처럼 보인다.
    var emptyEl = document.getElementById("emptyState");
    if (emptyEl) galleryEl.parentNode.insertBefore(emptyEl, galleryEl);
    galleryEl.parentNode.insertBefore(photoRail.section, galleryEl.nextSibling);

    loadClassCodes().then(function () {
      // 반코드(반이름→반코드)가 늦게 로드되면, 지금 보고 있는 반의 그림책 레일만 다시 채운다.
      // (첫 렌더 때 코드가 없어 비어 있던 캐시를 지우고 새로 가져온다)
      if (currentClass) { delete booksByClass[currentClass]; fillBooks(bookRail, currentClass); }
    });

    function apply() {
      var inClass = !head.hidden;
      var name = (titleEl && titleEl.textContent || "").trim();
      artHead.hidden = !inClass;
      if (!inClass) {
        bookRail.section.hidden = true;
        photoRail.section.hidden = true;
        emitBookNames([]);   // 홈으로 나가면 그림책 이름은 지운다(다른 반 이름이 남지 않게)
        currentClass = "";
        return;
      }
      if (name === currentClass) {
        // 같은 반이면 다시 그리지 않는다. 다만 화면 전환 때 숨겨둔 레일은
        // 내용이 있으면 다시 보여준다(그림책 줄이 사라진 채 남는 문제 방지).
        if (bookRail.track.childElementCount) bookRail.section.hidden = false;
        if (photoRail.track.childElementCount ||
            photoRail.section.querySelector(".rail-gate, .rail-days")) photoRail.section.hidden = false;
        return;
      }
      currentClass = name;
      fillBooks(bookRail, name);
      fillPhotos(photoRail, name);
    }
    // 학교(반) 머리말이 보이는지 + 이름이 바뀌는지 둘 다 지켜본다.
    new MutationObserver(apply).observe(head, { attributes: true, attributeFilter: ["hidden"] });
    if (titleEl) new MutationObserver(apply).observe(titleEl, { childList: true, characterData: true, subtree: true });
    apply();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
