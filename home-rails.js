/* =========================================================
   Artable 갤러리 — 클래스 안의 가로 줄(레일)
     클래스 카드 → (비밀번호) → 📚 그림책 · 🎨 우리 그림 · 📷 수업 모습

   홈(클래스 카드 나열)은 기존 script.js 그대로 두고,
   클래스로 들어갔을 때만 작품 그리드 위/아래에 레일을 붙인다.
   가운데 '우리 그림'은 기존 그리드를 그대로 쓴다(검색·정렬·모달·관리자 기능 유지).
   ========================================================= */
(function () {
  "use strict";

  var REPORT_API = "https://script.google.com/macros/s/AKfycbyV5LibT5DHLAIwujt8u8yjkyBtxpzSMF5T2aepcPdbgvQITCKc7kou4mlqcNxIvLKZ/exec";
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

  /// 이 반의 온라인 발행 그림책을 GAS에서 가져온다(뷰어와 같은 출처).
  /// Firestore storybooks 문서는 bookId가 비어 있어(발행 시 되쓰지 않음) 쓰지 않는다.
  /// 반이 여러 반코드를 가질 수 있어(codesByClass) 코드별로 모아 bookId로 중복 제거한다.
  function loadBooksForClass(className) {
    if (booksByClass[className]) return Promise.resolve(booksByClass[className]);
    var codes = Object.keys(codesByClass[className] || {});
    // 코드 대신 반이름을 코드로 쓰는 반도 있어 함께 시도.
    if (codes.indexOf(className) < 0) codes = codes.concat([className]);
    if (!codes.length) return Promise.resolve([]);
    return Promise.all(codes.map(function (code) {
      return fetch(BOOKS_API + "?class=" + encodeURIComponent(code))
        .then(function (r) { return r.json(); })
        .then(function (j) { return (j && j.ok && j.books) ? j.books : []; })
        .catch(function () { return []; });
    })).then(function (lists) {
      var seen = {}, out = [];
      lists.forEach(function (books) {
        (books || []).forEach(function (b) {
          if (!b.bookId || seen[b.bookId]) return;
          seen[b.bookId] = true;
          out.push(b);
        });
      });
      booksByClass[className] = out;
      return out;
    });
  }

  // ---------- 📚 그림책 ----------

  function fillBooks(rail, className) {
    loadBooksForClass(className).then(function (mine) {
      rail.track.innerHTML = "";
      if (!mine.length) { rail.section.hidden = true; return; }
      mine.forEach(function (b) {
        var title = (b.title || "").trim() || "그림책";
        var del = isAdmin ? function () { deleteBookOnline(b, rail, className); } : null;
        rail.track.appendChild(tile(b.cover, title, b.student || "", function () {
          location.href = VIEWER + "?book=" + encodeURIComponent(b.bookId);
        }, false, del));
      });
      rail.setCount(mine.length + "권" + (isAdmin ? " · 관리자" : ""));
      rail.section.hidden = false;
      rail.sync();
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
            ".\n\nGAS 스크립트 속성 STORYBOOK_ADMIN_KEY를 관리자 비밀번호와 같게 설정하고 재배포했는지 확인해 주세요.");
          return;
        }
        if (booksByClass[className]) {
          booksByClass[className] = booksByClass[className].filter(function (x) { return x.bookId !== book.bookId; });
        }
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
    var saved = localStorage.getItem("reportPw");
    if (saved) { input.value = saved; open(saved, true); }
    btn.addEventListener("click", function () { open(input.value.trim(), false); });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") btn.click(); });

    function open(pw, quiet) {
      if (!pw) return;
      if (!quiet) err.textContent = "여는 중…";
      fetch(REPORT_API, {
        method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "reportTree", secret: "artclasshub-2026", pw: pw })
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.ok) {
            localStorage.removeItem("reportPw");
            err.textContent = d.message || "열지 못했어요.";
            return;
          }
          localStorage.setItem("reportPw", pw);
          reportData = d.dates || [];
          gate.remove();
          renderPhotos(rail, className);
        })
        .catch(function () { err.textContent = "연결에 실패했어요."; });
    }
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
    var byFolder = {}, days = [];
    (reportData || []).forEach(function (day) {
      var orgs = day.orgs.filter(function (o) { return o.org === className; });
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

    // 관리자 모드 on/off 시 그림책 레일만 다시 그려 삭제 버튼을 붙이거나 없앤다.
    document.addEventListener("gallery-admin", function (e) {
      isAdmin = !!(e && e.detail);
      if (currentClass && bookRailRef) fillBooks(bookRailRef, currentClass);
    });
    var artHead = document.createElement("h2");
    artHead.className = "rail-title rail-standalone";
    artHead.textContent = "🎨 우리 그림";
    artHead.hidden = true;

    galleryEl.parentNode.insertBefore(bookRail.section, galleryEl);
    galleryEl.parentNode.insertBefore(artHead, galleryEl);
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
        currentClass = "";
        return;
      }
      if (name === currentClass) return;   // 같은 반이면 다시 그리지 않는다
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
