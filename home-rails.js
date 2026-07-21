/* =========================================================
   Artable 갤러리 — 홈 가로 줄(레일)
     📚 그림책  |  🎨 그림  |  📷 수업 모습(비밀번호)
   기존 script.js 는 건드리지 않고, 홈 화면 위/아래에 얹는다.
   학교로 들어가면(#schoolHeader 가 보이면) 레일은 숨는다.
   ========================================================= */
(function () {
  "use strict";

  var REPORT_API = "https://script.google.com/macros/s/AKfycbyV5LibT5DHLAIwujt8u8yjkyBtxpzSMF5T2aepcPdbgvQITCKc7kou4mlqcNxIvLKZ/exec";
  var VIEWER = "viewer.html";

  var $ = function (id) { return document.getElementById(id); };

  /// 가로로 부드럽게 옮긴다.
  /// scroll-behavior:smooth 와 scroll-snap 을 같이 쓰면 코드로 건 스크롤이 스냅 엔진에
  /// 취소되는 브라우저가 있어, 직접 한 프레임씩 그린다. 프레임이 안 도는 상황(백그라운드 탭)
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

  /// 레일 한 줄을 만든다. { id, icon, title, note } → { section, track, setCount }
  function makeRail(opt) {
    var sec = document.createElement("section");
    sec.className = "rail"; sec.id = opt.id;
    sec.innerHTML =
      '<div class="rail-head">' +
        '<h2 class="rail-title">' + opt.icon + " " + opt.title + "</h2>" +
        '<span class="rail-cnt"></span>' +
        '<button class="rail-arrow" type="button" aria-label="이전">‹</button>' +
        '<button class="rail-arrow" type="button" aria-label="다음">›</button>' +
      "</div>" +
      (opt.note ? '<p class="rail-note">' + opt.note + "</p>" : "") +
      '<div class="rail-track"></div>';

    var track = sec.querySelector(".rail-track");
    var arrows = sec.querySelectorAll(".rail-arrow");
    function sync() {
      var end = track.scrollWidth - track.clientWidth - 2;
      arrows[0].disabled = track.scrollLeft <= 2;
      arrows[1].disabled = track.scrollLeft >= end;
      // 한 화면에 다 들어오면 화살표를 숨긴다.
      var hide = track.scrollWidth <= track.clientWidth + 2;
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

  function tile(imgUrl, line1, line2, onClick, isVideo) {
    var el = document.createElement("div");
    el.className = "rail-tile";
    el.innerHTML =
      '<div class="rail-thumb">' +
        (imgUrl ? '<img loading="lazy" alt="">' : '<div class="rail-noimg">🖼</div>') +
        (isVideo ? '<span class="rail-play">▶</span>' : "") +
      "</div>" +
      '<p class="rail-l1"></p>' +
      (line2 ? '<p class="rail-l2"></p>' : "");
    if (imgUrl) {
      var im = el.querySelector("img");
      im.src = imgUrl;
      im.addEventListener("error", function () { im.style.visibility = "hidden"; });
    }
    el.querySelector(".rail-l1").textContent = line1 || "";
    if (line2) el.querySelector(".rail-l2").textContent = line2;
    if (onClick) el.addEventListener("click", onClick);
    return el;
  }

  // ---------- 데이터 ----------

  function db() {
    try { return firebase.firestore(); } catch (e) { return null; }
  }

  /// 📚 온라인에 올라간 그림책 — storybooks 중 bookId 가 발급된 것.
  function loadBooks(rail) {
    var d = db();
    if (!d) { rail.section.hidden = true; return; }
    d.collection("storybooks").limit(300).get().then(function (snap) {
      var books = [];
      snap.forEach(function (doc) {
        var b = doc.data() || {};
        if (!b.bookId) return;                       // 아직 온라인에 안 올린 책
        books.push({
          bookId: b.bookId,
          title: b.title || "제목 없는 그림책",
          student: b.studentName || "",
          cover: b.thumbURL || (b.spreadThumbs && b.spreadThumbs[0]) || "",
          at: b.updatedAt && b.updatedAt.seconds ? b.updatedAt.seconds : 0
        });
      });
      books.sort(function (a, b) { return b.at - a.at; });
      if (!books.length) { rail.section.hidden = true; return; }
      books.forEach(function (b) {
        rail.track.appendChild(tile(b.cover, b.title, b.student, function () {
          location.href = VIEWER + "?book=" + encodeURIComponent(b.bookId);
        }));
      });
      rail.setCount(books.length + "권");
      rail.sync();
    }).catch(function () { rail.section.hidden = true; });
  }

  /// 🎨 최근 작품 — 기존 갤러리와 같은 컬렉션.
  function loadArt(rail) {
    var d = db();
    if (!d) { rail.section.hidden = true; return; }
    var CFG = window.GALLERY_CONFIG || {};
    d.collection(CFG.collection || "submissions").limit(300).get().then(function (snap) {
      var items = [];
      snap.forEach(function (doc) {
        var a = doc.data() || {};
        if (a.hidden) return;
        var url = a.thumbnail_url || a.image_url || a.url || "";
        if (!url) return;
        var ts = a[CFG.dateField || "created_at"];
        items.push({
          url: url,
          student: a.student_name || a.student || "",
          title: a.title || "",
          at: ts && ts.seconds ? ts.seconds : 0
        });
      });
      items.sort(function (a, b) { return b.at - a.at; });
      if (!items.length) { rail.section.hidden = true; return; }
      items.slice(0, 60).forEach(function (a) {
        rail.track.appendChild(tile(a.url, a.student, a.title, null));
      });
      rail.setCount(items.length + "점");
      rail.sync();
    }).catch(function () { rail.section.hidden = true; });
  }

  /// 📷 수업 모습 — 아이 얼굴이 담긴 사진이라 비밀번호를 넣어야 열린다.
  function setupPhotos(rail) {
    var gate = document.createElement("div");
    gate.className = "rail-gate";
    gate.innerHTML =
      '<p>수업 사진은 아이들 얼굴이 담겨 있어 비밀번호를 넣어야 보여요.</p>' +
      '<div class="rail-gate-row">' +
        '<input type="password" placeholder="비밀번호" autocomplete="current-password">' +
        "<button type=\"button\">열기</button>" +
      "</div>" +
      '<span class="rail-gate-err"></span>';
    rail.section.insertBefore(gate, rail.track);

    var input = gate.querySelector("input");
    var btn = gate.querySelector("button");
    var err = gate.querySelector(".rail-gate-err");

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
          err.textContent = "";
          gate.remove();
          renderPhotos(rail, d.dates || []);
        })
        .catch(function () { err.textContent = "연결에 실패했어요."; });
    }
  }

  /// 날짜 카드 → 고른 날의 사진을 한 줄로.
  function renderPhotos(rail, dates) {
    if (!dates.length) { rail.section.hidden = true; return; }

    var bar = document.createElement("div");
    bar.className = "rail-days";
    rail.section.insertBefore(bar, rail.track);

    var pick = dates[0].folder;
    function dparts(f) {
      var g = String(f).replace(/[^0-9]/g, "");
      if (g.length !== 8) return { m: String(f), y: "" };
      return { m: (+g.substr(4, 2)) + "/" + (+g.substr(6, 2)), y: g.substr(0, 4) };
    }

    function draw() {
      bar.innerHTML = "";
      dates.forEach(function (day) {
        var p = dparts(day.folder), n = 0;
        day.orgs.forEach(function (o) { o.programs.forEach(function (pr) { n += pr.photos.length; }); });
        var c = document.createElement("button");
        c.type = "button";
        c.className = "rail-day" + (day.folder === pick ? " on" : "");
        c.innerHTML = '<span class="y">' + p.y + '</span><span class="d">' + p.m + '</span>'
          + '<span class="n">' + n + "개</span>";
        c.addEventListener("click", function () { pick = day.folder; draw(); });
        bar.appendChild(c);
      });

      var day = dates.filter(function (d) { return d.folder === pick; })[0];
      rail.track.innerHTML = "";
      var shots = [];
      day.orgs.forEach(function (o) {
        o.programs.forEach(function (pr) {
          pr.photos.forEach(function (ph) { shots.push({ ph: ph, org: o.org, prog: pr.title }); });
        });
      });
      shots.forEach(function (s, i) {
        rail.track.appendChild(tile(s.ph.thumb, s.org, s.prog, function () {
          lightbox(shots, i);
        }, s.ph.kind === "video"));
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
    var main = document.querySelector("main") || document.body;
    var galleryEl = $("gallery");
    var anchor = galleryEl ? (galleryEl.parentNode === main ? galleryEl : main.firstChild) : main.firstChild;

    var books = makeRail({ id: "railBooks", icon: "📚", title: "그림책" });
    var art = makeRail({ id: "railArt", icon: "🎨", title: "우리 그림" });
    var photos = makeRail({ id: "railPhotos", icon: "📷", title: "수업 모습" });

    main.insertBefore(books.section, anchor);
    main.insertBefore(art.section, anchor);
    main.appendChild(photos.section);   // 수업 모습은 맨 아래

    loadBooks(books);
    loadArt(art);
    setupPhotos(photos);

    // 학교로 들어가면(학교 머리말이 보이면) 레일은 접어 둔다.
    var head = $("schoolHeader");
    if (head) {
      var apply = function () {
        var inSchool = !head.hidden;
        [books.section, art.section, photos.section].forEach(function (s) {
          s.classList.toggle("rail-off", inSchool);
        });
      };
      new MutationObserver(apply).observe(head, { attributes: true, attributeFilter: ["hidden"] });
      apply();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
