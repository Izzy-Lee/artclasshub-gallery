/* 포트폴리오 하위 갤러리 3종 공용 스크립트.
   어떤 갤러리인지는 <body data-gallery="class|works|books"> 로 정한다.
   자료는 본 페이지와 똑같은 곳에서 읽는다 — 사진은 portfolio.json, 작품은 Firestore,
   그림책은 그림책 웹앱. 그래서 이 페이지들만 따로 갱신할 일이 없다. */
(function () {
  "use strict";
  var KIND = document.body.getAttribute("data-gallery");
  var BOOKS_API = "https://script.google.com/macros/s/AKfycbzBg9ghzZSLv0J3MlUWMNVscBQuKVd2JgYS-HyiBAuqzPEh5qbGCUW9o_PorKOILx4/exec";
  var VIEWER = "viewer.html";
  var STEP = 60;

  var $ = function (id) { return document.getElementById(id); };
  var IMG = function (id, w) { return "https://lh3.googleusercontent.com/d/" + id + "=w" + (w || 600); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
    });
  };
  var prettyDate = function (s) {
    var g = String(s).replace(/[^0-9]/g, "");
    return g.length === 8 ? (+g.substr(4, 2)) + "월 " + (+g.substr(6, 2)) + "일" : s;
  };
  function icon(d, size) {
    return '<svg width="' + (size || 20) + '" height="' + (size || 20) + '" viewBox="0 0 24 24" fill="none"'
         + ' stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
         + ' aria-hidden="true">' + d + "</svg>";
  }
  var IC = {
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>'
  };

  /* 라이트박스 ---------------------------------------------------- */
  var LB = { list: [], at: 0 };
  function lbShow() {
    var it = LB.list[LB.at];
    if (!it) return;
    var im = $("lbImg");
    im.removeAttribute("style");
    if (it.half) {
      im.onload = function () {
        if (im.naturalWidth > im.naturalHeight * 1.15) {
          im.style.objectFit = "cover";
          im.style.objectPosition = "right center";
          im.style.aspectRatio = (im.naturalWidth / 2) + " / " + im.naturalHeight;
          im.style.width = "auto";
          im.style.maxHeight = "78vh";
        }
      };
    } else { im.onload = null; }
    im.src = it.img;
    $("lbCap").textContent = it.cap || "";
    if (it.link) { $("lbOpen").href = it.link; $("lbOpen").hidden = false; }
    else { $("lbOpen").hidden = true; }
    $("lb").classList.add("on");
  }
  function lbOpen(list, at) { LB.list = list; LB.at = at; lbShow(); }
  $("lb").addEventListener("click", function (e) {
    if ((e.target.closest && e.target.closest("[data-close]")) || e.target.id === "lb") {
      $("lb").classList.remove("on"); return;
    }
    var b = e.target.closest ? e.target.closest("[data-step]") : null;
    if (b) { LB.at = (LB.at + Number(b.getAttribute("data-step")) + LB.list.length) % LB.list.length; lbShow(); }
  });
  document.addEventListener("keydown", function (e) {
    if (!$("lb").classList.contains("on")) return;
    if (e.key === "Escape") $("lb").classList.remove("on");
    if (e.key === "ArrowRight") { LB.at = (LB.at + 1) % LB.list.length; lbShow(); }
    if (e.key === "ArrowLeft") { LB.at = (LB.at - 1 + LB.list.length) % LB.list.length; lbShow(); }
  });
  $("lbClose").innerHTML = icon(IC.x, 26);
  $("lbPrev").innerHTML = icon(IC.left, 22);
  $("lbNext").innerHTML = icon(IC.right, 22);
  $("lbOpen").innerHTML = icon(IC.book, 17) + " 그림책 펼쳐 보기";

  /* 공통 상태 ----------------------------------------------------- */
  var ALL = [], cur = "", limit = STEP;

  function pool() {
    return cur ? ALL.filter(function (x) { return x.key === cur; }) : ALL;
  }
  function drawTabs(keys) {
    var box = $("tabs");
    box.innerHTML = "";
    [""].concat(keys).forEach(function (k) {
      var b = document.createElement("button");
      b.textContent = k || "전체";
      if (!k) b.className = "on";
      b.onclick = function () {
        cur = k; limit = STEP;
        [].forEach.call(box.children, function (c) { c.className = ""; });
        b.className = "on";
        draw();
      };
      box.appendChild(b);
    });
  }
  var UNIT = KIND === "books" ? "권" : (KIND === "class" ? "장" : "점");
  function updateCount() {
    var p = pool();
    $("count").innerHTML = "모두 <b>" + ALL.length + "</b>" + UNIT
      + (cur ? " 중 " + esc(cur) + " <b>" + p.length + "</b>" + UNIT : "");
  }
  function drawMore(shownCount) {
    var rest = pool().length - shownCount;
    var m = $("more");
    m.hidden = rest <= 0;
    $("moreBtn").textContent = "더 보기 (+" + Math.min(STEP, rest) + ")";
  }

  function draw() {
    var list = pool().slice(0, limit);
    var grid = $("grid");
    if (!list.length) {
      grid.innerHTML = '<p class="empty">아직 올라온 자료가 없습니다.</p>';
      $("more").hidden = true; updateCount(); return;
    }
    if (KIND === "books") {
      grid.innerHTML = list.map(function (b, i) {
        return '<div class="book" data-i="' + i + '"><div class="cov">'
             + (b.cover ? '<div class="face" data-src="' + esc(b.cover) + '"></div>' : "")
             + '</div><p>' + esc(b.title) + "</p></div>";
      }).join("");
      // 첫 장이 [뒤표지|앞표지] 펼침면이면 오른쪽 절반(진짜 표지)만 보여 준다
      [].forEach.call(grid.querySelectorAll(".face"), function (el, i) {
        var src = el.getAttribute("data-src");
        el.style.backgroundImage = 'url("' + src + '")';
        var probe = new Image();
        probe.onload = function () {
          var spread = probe.naturalWidth > probe.naturalHeight * 1.15;
          if (spread) el.classList.add("spread");
          list[i].spread = spread;
        };
        probe.src = src;
      });
    } else {
      grid.innerHTML = list.map(function (x, i) {
        return '<div class="cell' + (x.raw ? " raw" : "") + '" data-i="' + i + '">'
             + '<img loading="lazy" decoding="async" src="' + esc(x.thumb) + '" alt="">'
             + (x.raw ? '<span class="pend">얼굴 처리 전</span>' : "")
             + (x.cap ? '<span class="cap">' + esc(x.cap) + "</span>" : "")
             + "</div>";
      }).join("");
    }
    grid.onclick = function (e) {
      var el = e.target.closest ? e.target.closest("[data-i]") : null;
      if (!el) return;
      var i = Number(el.getAttribute("data-i"));
      lbOpen(list.map(function (x) {
        return KIND === "books"
          ? { img: x.cover, half: !!x.spread, cap: x.title + " — 아이가 쓰고 그린 그림책",
              link: VIEWER + "?book=" + encodeURIComponent(x.bookId) }
          : { img: x.full, cap: x.cap || "" };
      }), i);
    };
    drawMore(list.length);
    updateCount();
  }

  $("moreBtn").addEventListener("click", function () {
    var from = $("grid").children.length;
    limit += STEP;
    draw();
    var el = $("grid").children[from];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  /* 자료 읽기 ----------------------------------------------------- */
  function loadManifest() {
    return fetch("portfolio.json?v=" + Date.now())
      .then(function (r) { return r.ok ? r.json() : fetch("manifest.json").then(function (x) { return x.json(); }); })
      .catch(function () { return fetch("manifest.json").then(function (x) { return x.json(); }); });
  }

  if (KIND === "class") {
    loadManifest().then(function (m) {
      ALL = (m.photos || []).map(function (p) {
        return { key: p.org, thumb: IMG(p.id, 600), full: IMG(p.id, 1400), raw: p.face !== "sticker",
                 cap: p.org + " · " + prettyDate(p.date) };
      });
      var keys = [];
      ALL.forEach(function (x) { if (keys.indexOf(x.key) < 0) keys.push(x.key); });
      drawTabs(keys);
      draw();
    });
  }

  if (KIND === "works") {
    loadManifest().then(function (m) {
      var cats = (m.media || []).map(function (x) { return x.cat; });
      try {
        firebase.initializeApp({
          apiKey: "AIzaSyAcW1Jx01XkI15Ga5Ln3dsSSx0K8f3CsFY",
          authDomain: "artclass-hub.firebaseapp.com",
          projectId: "artclass-hub",
          storageBucket: "artclass-hub.firebasestorage.app",
          messagingSenderId: "122881163606",
          appId: "1:122881163606:web:artclasshubgallery"
        });
        firebase.firestore().collection("submissions").limit(500).get().then(function (snap) {
          snap.forEach(function (d) {
            var a = d.data();
            if (a.hidden === true) return;
            var url = a.thumbnail_url || a.download_url || "";
            if (!url) return;
            ALL.push({ key: (a.category || "").trim(), thumb: url, full: url,
                       cap: (a.category || "").trim() });
          });
          ALL.sort(function (a, b) { return (b.key ? 1 : 0) - (a.key ? 1 : 0); });
          drawTabs(cats.filter(function (c) {
            return ALL.some(function (x) { return x.key === c; });
          }));
          draw();
        });
      } catch (e) {
        $("grid").innerHTML = '<p class="empty">작품을 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요.</p>';
      }
    });
  }

  if (KIND === "books") {
    loadManifest().then(function (m) {
      var codes = m.classCodes || [], seen = {};
      return Promise.all(codes.map(function (c) {
        return fetch(BOOKS_API + "?class=" + encodeURIComponent(c))
          .then(function (r) { return r.json(); })
          .then(function (j) { return (j && j.books) || []; })
          .catch(function () { return []; });
      })).then(function (lists) {
        lists.forEach(function (books) {
          books.forEach(function (b) {
            if (!b.bookId || seen[b.bookId]) return;
            seen[b.bookId] = true;
            ALL.push({ key: "", bookId: b.bookId, cover: b.cover, title: (b.title || "그림책").trim() });
          });
        });
        $("tabs").hidden = true;
        draw();
      });
    });
  }
})();
