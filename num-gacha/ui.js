/* NUM GACHA — 画面 (ロジックは logic.js) */
(function () {
  'use strict';
  var G = window.NumGacha, CFG = G.CONFIG, MAX = G.MAX;

  /* 画面まわりの設定 (DESIGN.md「コレクション画面」参照) */
  var UI = {
    fullGridMax: 99,      // 範囲の数がこれ以下の桁 (1〜2桁) は未解放も全部マス表示
    gapCollapse: 3,       // これより長い未解放の連続は「未解放 n 個」の1行にまとめる
    pageSize: 240,        // 折りたたみ表示で一度に描く解放済みの数
    defaultView: 'fold',  // 'fold' = 桁ごとに折りたたむ / 'zoom' = 10進ズーム
    revealDigitMs: 55     // 開封で1桁ずつ出す間隔
  };

  var $ = function (id) { return document.getElementById(id); };
  var state = G.load();
  var sorted = null; // 解放済み昇順キャッシュ
  function unlocked() { if (!sorted) sorted = G.unlockedSorted(state); return sorted; }
  function persist() { sorted = null; G.save(state); }

  var RANK = {}; CFG.rarities.forEach(function (r, i) { RANK[r.id] = CFG.rarities.length - 1 - i; });
  function rar(n) { return G.rarityOf(n); }
  function paint(el, r) {
    el.style.setProperty('--c', r.color); el.style.setProperty('--g', r.glow);
  }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function oneIn(p) { return p >= 0.01 ? (p * 100).toFixed(p >= 0.1 ? 1 : 2) + '%' : '1/' + G.fmt(Math.round(1 / p)); }
  function rarityTag(r) { return '<span class="tag' + (r.rainbow ? ' rainbow-bg' : '') + '" style="--c:' + r.color + ';--g:' + r.glow + '">' + r.name + '</span>'; }
  function bigCount(x) { // 大きな個数を短く (日本語の万・億・兆・京)
    var u = [[1e16, '京'], [1e12, '兆'], [1e8, '億'], [1e4, '万']];
    for (var i = 0; i < u.length; i++) if (x >= u[i][0]) { var v = x / u[i][0]; return (v >= 100 ? Math.round(v) : +v.toPrecision(3)) + u[i][1]; }
    return G.fmt(x);
  }

  /* ===================== 更新・タイマー ===================== */
  function tick() {
    var now = Date.now();
    if (G.refresh(state, now)) { persist(); renderGacha(); showToast('<b>回数が回復しました</b>(' + CFG.pullsPerRefresh + '回)', null); }
    var ms = Math.max(0, G.nextRefreshAt(now) - now);
    var s = Math.floor(ms / 1000);
    var hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60;
    $('countdown').textContent = [hh, mm, ss].map(function (x) { return String(x).padStart(2, '0'); }).join(':');
  }

  /* ===================== ガチャ画面 ===================== */
  function renderGacha() {
    var pips = $('pips'); pips.innerHTML = '';
    for (var i = 0; i < CFG.pullsPerRefresh; i++) pips.appendChild(el('span', 'pip' + (i < state.pullsLeft ? ' on' : '')));
    pips.appendChild(el('span', 'lbl', '残り ' + state.pullsLeft + ' 回'));
    var left = state.pullsLeft, busy = !!playing;
    $('btn1').disabled = left < 1 || busy; $('btnAll').disabled = left < 2 || busy;
    $('btn1sub').textContent = left ? '残り ' + left + ' 回' : '次の更新を待ってね';
    $('btnAllsub').textContent = '×' + Math.max(left, 0);
    var hours = [];
    for (var h = 0; h < 24; h += CFG.refreshHours) hours.push(h + ':00');
    $('note').innerHTML = '毎日 ' + hours.join(' / ') + ' に ' + CFG.pullsPerRefresh + ' 回に戻ります(貯まりません)<br>同じ数字が ' + CFG.carryThreshold + ' 枚そろうと、1つ上の数字に繰り上がり';
    var rc = $('recent'); rc.innerHTML = '';
    if (!state.history.length) rc.appendChild(el('span', 'empty', 'まだありません'));
    state.history.slice(0, 14).forEach(function (h) {
      var r = rar(h.n), c = el('span', 'chip' + (r.rainbow ? ' rainbow-text' : ''), G.fmt(h.n));
      paint(c, r); rc.appendChild(c);
    });
  }

  function renderRates() {
    var t = $('rates');
    var html = '<tr><th>ランク</th><th>数字</th><th class="r">確率</th></tr>';
    G.rarityTable().forEach(function (row) {
      var r = row.rarity;
      var range = r.isMax ? G.fmt(MAX) + ' のみ' : (G.digitsOf(row.lo) === G.digitsOf(row.hi) ? G.digitsOf(row.lo) + '桁' : G.digitsOf(row.lo) + '〜' + G.digitsOf(row.hi) + '桁');
      html += '<tr><td>' + rarityTag(r) + '</td><td>' + range + '</td><td class="r">' + oneIn(row.p) + '</td></tr>';
    });
    t.innerHTML = html;
    $('ratenote').innerHTML = '桁が1つ増えるごとに、その桁が出る確率は約 ' + CFG.digitRatio + ' 倍になります。同じ桁の数字はどれも同じ確率です(1 は ' +
      oneIn(G.probExact(1)) + '、10 は ' + oneIn(G.probExact(10)) + '、最大値は ' + oneIn(G.probExact(MAX)) + ')。';
  }

  // 背景に漂う数字
  (function floaters() {
    var f = $('floaters');
    for (var i = 0; i < 14; i++) {
      var s = el('i', null, String(G.drawNumber()).slice(0, 6));
      s.style.left = (Math.random() * 92) + '%';
      s.style.fontSize = (10 + Math.random() * 16) + 'px';
      s.style.animationDelay = (-Math.random() * 7) + 's';
      s.style.animationDuration = (5 + Math.random() * 5) + 's';
      f.appendChild(s);
    }
  })();

  /* ===================== 開封演出 ===================== */
  var playing = null; // { results, i, phase, timers }
  var fx = $('fx'), ctx = fx.getContext('2d'), parts = [], fxRun = false;

  function resizeFx() { var d = Math.min(window.devicePixelRatio || 1, 2); fx.width = innerWidth * d; fx.height = innerHeight * d; ctx.setTransform(d, 0, 0, d, 0, 0); }
  function burst(r, amount) {
    var cx = innerWidth / 2, cy = innerHeight * 0.45;
    for (var i = 0; i < amount; i++) {
      var a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * (4 + amount / 40);
      parts.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, decay: 0.008 + Math.random() * 0.014,
        size: 1.5 + Math.random() * 3.5, hue: r.rainbow ? Math.random() * 360 : null, color: Math.random() < 0.3 ? '#ffffff' : r.color, star: Math.random() < 0.25 });
    }
    if (!fxRun) { fxRun = true; requestAnimationFrame(stepFx); }
  }
  function sparkle(r) { // 待機中のキラキラ
    var cx = innerWidth / 2, cy = innerHeight * 0.45;
    for (var i = 0; i < 3; i++) {
      var a = Math.random() * Math.PI * 2, d = 120 + Math.random() * 80;
      parts.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, vx: -Math.cos(a) * 1.6, vy: -Math.sin(a) * 1.6, life: 1, decay: 0.02,
        size: 1.5 + Math.random() * 2, hue: r.rainbow ? Math.random() * 360 : null, color: r.color, star: false });
    }
    if (!fxRun) { fxRun = true; requestAnimationFrame(stepFx); }
  }
  function stepFx() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.globalCompositeOperation = 'lighter';
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.x += p.vx; p.y += p.vy; p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.03; p.life -= p.decay;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.hue != null ? 'hsl(' + ((p.hue + Date.now() / 8) % 360) + ',100%,65%)' : p.color;
      if (p.star) {
        var s = p.size * 2.2; ctx.fillRect(p.x - s, p.y - 0.6, s * 2, 1.2); ctx.fillRect(p.x - 0.6, p.y - s, 1.2, s * 2);
      } else { ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (parts.length) requestAnimationFrame(stepFx); else { fxRun = false; ctx.clearRect(0, 0, innerWidth, innerHeight); }
  }

  function startPulls(count) {
    if (playing) return;
    var results = [];
    for (var i = 0; i < count; i++) {
      var res = G.pull(state, Date.now());
      if (!res) break;
      results.push(res);
    }
    if (!results.length) return;
    persist(); // 先に保存 (演出中に閉じても結果は残る)
    playing = { results: results, i: 0, phase: null, timers: [] };
    renderGacha();
    $('orb').classList.add('busy');
    resizeFx();
    $('reveal').hidden = false;
    playOne();
  }

  function later(ms, fn) { playing.timers.push(setTimeout(fn, ms)); }
  function clearTimers() { playing.timers.forEach(clearTimeout); playing.timers = []; }

  function playOne() {
    var res = playing.results[playing.i], n = res.n, r = rar(n), rank = RANK[r.id];
    var rv = $('reveal');
    rv.className = 'reveal';
    $('rvcount').textContent = (playing.i + 1) + ' / ' + playing.results.length;
    $('rvskip').style.visibility = playing.results.length > 1 ? 'visible' : 'hidden';
    $('rvhint').textContent = 'タップで開封';
    $('card').innerHTML = '';
    // 昇格演出: 低いランクの色から順に上げていく。ランクが高いほど溜めが長い
    var ladder = CFG.rarities.slice().reverse().filter(function (x) { return RANK[x.id] <= rank && (RANK[x.id] === rank || RANK[x.id] % 2 === 0 || RANK[x.id] >= 3); });
    var chargeMs = 700 + rank * 260;
    playing.phase = 'charge';
    void rv.offsetWidth;
    var curStep = ladder[0];
    paint(rv, curStep);
    rv.classList.add('charge');
    if (rank >= 4) rv.classList.add('hard');
    ladder.forEach(function (step, k) {
      if (k === 0) return;
      later(chargeMs * k / ladder.length, function () { curStep = step; paint(rv, step); burst(step, 18); if (navigator.vibrate && RANK[step.id] >= 5) navigator.vibrate(30); });
    });
    var sp = setInterval(function () { if (playing && playing.phase === 'charge') sparkle(curStep); }, 90);
    playing.timers.push(sp);
    later(chargeMs, function () { clearInterval(sp); doBurst(); });
  }

  function doBurst() {
    var res = playing.results[playing.i], n = res.n, r = rar(n), rank = RANK[r.id];
    var rv = $('reveal');
    clearTimers();
    playing.phase = 'burst';
    paint(rv, r);
    rv.classList.remove('charge', 'hard');
    rv.classList.add('burst');
    burst(r, 40 + rank * rank * 12);
    if (rank >= 6) { later(250, function () { burst(r, 160); }); later(600, function () { burst(r, 160); }); }
    if (navigator.vibrate && rank >= 4) navigator.vibrate(rank >= 6 ? [60, 40, 120] : 50);
    later(380, showCard);
  }

  function showCard() {
    var res = playing.results[playing.i], n = res.n, r = rar(n);
    var rv = $('reveal'), card = $('card');
    clearTimers();
    playing.phase = 'shown';
    paint(rv, r);
    rv.classList.remove('burst');
    rv.classList.add('shown');
    var s = G.fmt(n), isNew = res.events[0].isNew;
    var fs = Math.min(innerWidth * 0.86 / (s.length * 0.62), innerWidth * 0.3, 150);
    var numHtml = s.split('').map(function (ch) { return '<span' + (ch === ',' ? ' class="cm"' : '') + '>' + ch + '</span>'; }).join('');
    var carries = res.events.slice(1).map(function (e, k) {
      var from = res.events[k].n;
      return '<div>' + G.fmt(from) + ' が ' + CFG.carryThreshold + ' 枚そろった → <b>' + G.fmt(e.n) + '</b> ' + (e.isNew ? '<b>解放!</b>' : 'を1枚獲得') + '</div>';
    }).join('');
    var e0 = state.counts[String(n)];
    card.innerHTML = '<div class="rk' + (r.rainbow ? ' rainbow-bg' : '') + '">' + r.name + ' · ' + r.label + '</div>' +
      '<div class="num' + (r.rainbow ? ' rainbow' : '') + '" style="font-size:' + fs.toFixed(1) + 'px">' + numHtml + '</div>' +
      '<div class="meta">' + G.digitsOf(n) + '桁 · 出る確率 ' + oneIn(G.probExact(n)) + (isNew ? '<span class="new">NEW</span>' : '') +
      '<br><span style="color:var(--muted);font-weight:600">' + (res.events.length > 1 ? '' : n === MAX ? '手持ち ' + G.fmt(e0.c) + ' 枚' : '手持ち ' + (e0 ? e0.c : 0) + ' / ' + CFG.carryThreshold) + '</span></div>' +
      (carries ? '<div class="carry">' + carries + '</div>' : '');
    var spans = card.querySelectorAll('.num span'), k = 0;
    var step = Math.max(25, Math.min(UI.revealDigitMs, 900 / spans.length));
    (function next() {
      if (!playing || playing.phase !== 'shown') return;
      if (k < spans.length) { spans[k++].classList.add('in'); later(step, next); }
      else { rv.classList.add('done'); $('rvhint').textContent = playing.i + 1 < playing.results.length ? 'タップで次へ' : 'タップで結果へ'; }
    })();
  }

  function finishCard() { // 数字を一気に出す
    clearTimers();
    $('card').querySelectorAll('.num span').forEach(function (s) { s.classList.add('in'); });
    $('reveal').classList.add('done');
    $('rvhint').textContent = playing.i + 1 < playing.results.length ? 'タップで次へ' : 'タップで結果へ';
  }

  function advance() {
    if (!playing) return;
    if (playing.phase === 'charge') { doBurst(); return; }
    if (playing.phase === 'burst') { showCard(); return; }
    if (!$('reveal').classList.contains('done')) { finishCard(); return; }
    playing.i++;
    if (playing.i < playing.results.length) playOne(); else endReveal();
  }

  function endReveal() {
    if (!playing) return;
    clearTimers();
    var results = playing.results;
    $('reveal').hidden = true; $('reveal').className = 'reveal';
    $('orb').classList.remove('busy');
    parts = [];
    if (results.length > 1) showSummary(results);
    playing = null;
    renderGacha();
    if (!$('screen-coll').hidden) renderColl();
  }

  function showSummary(results) {
    var list = $('sumlist'); list.innerHTML = '';
    results.forEach(function (res, i) {
      var r = rar(res.n), row = el('div', 'sumrow');
      paint(row, r); row.style.animationDelay = (i * 0.08) + 's';
      var extra = res.events.slice(1).map(function (e) { return '→ ' + G.fmt(e.n) + (e.isNew ? ' 解放' : ' +1'); }).join(' ');
      row.innerHTML = '<div class="h">' + rarityTag(r) + '<span class="n' + (r.rainbow ? ' rainbow-text' : '') + '">' + G.fmt(res.n) + '</span>' +
        (res.events[0].isNew ? '<span class="new" style="background:linear-gradient(90deg,#ff3d8b,#ffb800);border-radius:6px;padding:1px 6px;font-size:11px;font-weight:900">NEW</span>' : '') + '</div>' +
        '<div class="sub">' + G.digitsOf(res.n) + '桁 · ' + oneIn(G.probExact(res.n)) + (extra ? ' · 繰り上がり ' + extra : '') + '</div>';
      list.appendChild(row);
    });
    $('summary').hidden = false;
  }

  $('reveal').addEventListener('click', function (e) { if (e.target.id !== 'rvskip') advance(); });
  $('rvskip').addEventListener('click', function () { endReveal(); });
  $('sumclose').addEventListener('click', function () { $('summary').hidden = true; });
  $('btn1').addEventListener('click', function () { startPulls(1); });
  $('btnAll').addEventListener('click', function () { startPulls(state.pullsLeft); });
  window.addEventListener('resize', function () { if (playing) resizeFx(); });

  /* ===================== コレクション画面 ===================== */
  var view = (state.prefs && state.prefs.view) || UI.defaultView;
  var openFold = (state.prefs && state.prefs.open) || { 1: true };
  var foldLimit = {};
  var zoomPath = []; // 例: [] = 全体, ['7'] = 7桁, ['7','3'] = 3xxxxxx, ...

  function renderColl() {
    var arr = unlocked();
    var best = arr.length ? arr[arr.length - 1] : 0;
    $('stats').innerHTML =
      '<div class="stat"><span>解放した数字</span><b>' + G.fmt(arr.length) + ' 種</b></div>' +
      '<div class="stat"><span>最大の数字</span><b>' + (best ? G.fmt(best) : '-') + '</b></div>' +
      '<div class="stat"><span>まわした回数</span><b>' + G.fmt(state.totalPulls) + '</b></div>' +
      '<div class="stat"><span>繰り上がり</span><b>' + G.fmt(state.totalCarries) + ' 回</b></div>';
    var got = !!state.counts[String(MAX)], mr = G.rarityTable()[0].rarity, ms = $('maxslot');
    ms.className = 'maxslot ' + (got ? 'got' : 'locked');
    ms.innerHTML = '<div style="font-size:12px;color:var(--muted);margin-bottom:4px">最大値 ' + rarityTag(mr) + '</div><div class="n' + (got ? ' rainbow-text' : '') + '">' + G.fmt(MAX) + '</div>' +
      '<div style="font-size:11px;color:var(--muted);margin-top:4px">' + (got ? '解放済み · 累計 ' + state.counts[String(MAX)].t + ' 枚' : '未解放 · 1回あたり ' + oneIn(G.probExact(MAX))) + '</div>';
    document.querySelectorAll('#viewseg button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.view === view)); });
    $('viewhelp').textContent = view === 'fold'
      ? '桁ごとにまとめて表示。長く続く未解放は「未解放 n 個」の1行に省略します。'
      : '大きな範囲から10等分ずつ絞り込みます。x はまだ決まっていない桁です。';
    var body = $('collbody'); body.innerHTML = '';
    if (view === 'fold') renderFold(body, arr); else renderZoom(body, arr);
  }

  function cellFor(n, arr) {
    var e = state.counts[String(n)], r = rar(n), s = G.fmt(n);
    var c = el('div', 'cell' + (e ? '' : ' lock') + (s.length > 13 ? ' full' : s.length > 6 ? ' wide' : ''));
    if (e) paint(c, r);
    var dots = '';
    if (e) { dots = '<div class="dots">'; for (var i = 0; i < CFG.carryThreshold; i++) dots += '<i' + (i < e.c ? ' class="on"' : '') + '></i>'; dots += '</div>'; }
    c.innerHTML = '<div class="n' + (s.length > 13 ? ' l' : s.length > 5 ? ' s' : '') + (e && r.rainbow ? ' rainbow-text' : '') + '">' + s + '</div>' + dots;
    c.addEventListener('click', function () { showDetail(n); });
    return c;
  }

  function gapRow(lo, hi) {
    var g = el('div', 'gap');
    var len = hi - lo + 1;
    g.innerHTML = '<span>🔒 ' + G.fmt(lo) + (len > 1 ? ' 〜 ' + G.fmt(hi) : '') + '</span><b>未解放 ' + bigCount(len) + ' 個</b>';
    return g;
  }

  function renderFold(body, arr) {
    for (var d = 1; d <= 16; d++) (function (d) {
      var rg = G.digitRange(d), lo = rg[0], hi = rg[1];
      var total = hi - lo + 1, got = G.countIn(arr, lo, hi), r = rar(lo);
      var f = el('div', 'fold' + (openFold[d] ? ' open' : ''));
      paint(f, r);
      var pct = got / total * 100;
      var head = el('button');
      head.innerHTML = rarityTag(r) +
        '<div><span class="ttl">' + d + '桁</span><span class="rng">' + G.fmt(lo) + ' 〜 ' + G.fmt(hi) + '</span>' +
        '<div class="bar"><i style="width:' + (got ? Math.max(pct, 1.5) : 0) + '%"></i></div></div>' +
        '<div class="cnt"><b>' + G.fmt(got) + '</b> / ' + bigCount(total) + ' <span class="chev">▶</span></div>';
      head.addEventListener('click', function () { openFold[d] = !openFold[d]; savePrefs(); renderColl(); });
      f.appendChild(head);
      if (openFold[d]) {
        var b = el('div', 'body'), grid = el('div', 'grid');
        b.appendChild(grid); f.appendChild(b);
        if (total <= UI.fullGridMax) {
          for (var n = lo; n <= hi; n++) grid.appendChild(cellFor(n, arr));
        } else {
          var start = G.lowerBound(arr, lo), end = G.lowerBound(arr, hi + 1);
          var limit = foldLimit[d] || UI.pageSize, shown = 0, prev = lo - 1;
          for (var i = start; i < end && shown < limit; i++, shown++) {
            var m = arr[i], gap = m - prev - 1;
            if (gap > UI.gapCollapse) grid.appendChild(gapRow(prev + 1, m - 1));
            else for (var x = prev + 1; x < m; x++) grid.appendChild(cellFor(x, arr));
            grid.appendChild(cellFor(m, arr));
            prev = m;
          }
          if (shown < end - start) {
            var more = el('button', 'more', 'さらに表示(残り ' + G.fmt(end - start - shown) + ' 種)');
            more.addEventListener('click', function () { foldLimit[d] = (foldLimit[d] || UI.pageSize) + UI.pageSize; renderColl(); });
            grid.appendChild(more);
          } else if (prev < hi) {
            if (hi - prev > UI.gapCollapse) grid.appendChild(gapRow(prev + 1, hi));
            else for (var y = prev + 1; y <= hi; y++) grid.appendChild(cellFor(y, arr));
          }
        }
      }
      body.appendChild(f);
    })(d);
  }

  /* 10進ズーム: パスから範囲と子の一覧を作る */
  function zoomNode(path) {
    if (!path.length) {
      var kids = [];
      for (var d = 1; d <= 16; d++) { var rg = G.digitRange(d); kids.push({ lo: rg[0], hi: rg[1], label: d + '桁', path: [String(d)] }); }
      return { kids: kids };
    }
    var digits = +path[0], prefix = path.slice(1).join('');
    var rest = digits - prefix.length; // まだ決まっていない桁数
    var out = [];
    var first = prefix.length === 0 ? 1 : 0;
    for (var k = first; k <= 9; k++) {
      var p = prefix + k, free = rest - 1;
      var lo = Number(p + '0'.repeat(free)), hi = Number(p + '9'.repeat(free));
      if (lo > MAX) break;
      if (hi > MAX) hi = MAX;
      out.push({ lo: lo, hi: hi, label: groupX(p + 'x'.repeat(free)), path: path.concat(String(k)), leaf: free === 0 });
    }
    return { kids: out };
  }
  function groupX(s) { // "34xxxxx" → "3,4xx,xxx"
    var r = ''; for (var i = 0; i < s.length; i++) { if (i && (s.length - i) % 3 === 0) r += ','; r += s[i]; } return r;
  }

  function renderZoom(body, arr) {
    var crumbs = el('div', 'crumbs');
    var trail = [{ name: '全体', path: [] }];
    if (zoomPath.length) {
      trail.push({ name: zoomPath[0] + '桁', path: zoomPath.slice(0, 1) });
      for (var i = 2; i <= zoomPath.length; i++) {
        var pre = zoomPath.slice(1, i).join(''), free = +zoomPath[0] - pre.length;
        trail.push({ name: groupX(pre + 'x'.repeat(free)), path: zoomPath.slice(0, i) });
      }
    }
    // 深くなったら途中を「…」(1つ上へ) に省略して、全体・桁・直近2つだけ出す
    if (trail.length > 5) trail = trail.slice(0, 2).concat([{ name: '…', path: zoomPath.slice(0, zoomPath.length - 1) }], trail.slice(-2));
    trail.forEach(function (t, idx) {
      if (idx) crumbs.appendChild(el('span', null, '›'));
      var b = el('button', null, t.name);
      b.addEventListener('click', function () { zoomPath = t.path; renderColl(); });
      crumbs.appendChild(b);
    });
    body.appendChild(crumbs);
    var node = zoomNode(zoomPath);
    var leafLevel = node.kids.length && node.kids[0].leaf;
    if (leafLevel) {
      var grid = el('div', 'grid');
      node.kids.forEach(function (k) { grid.appendChild(cellFor(k.lo, arr)); });
      body.appendChild(grid);
      return;
    }
    var tiles = el('div', 'tiles');
    node.kids.forEach(function (k) {
      var total = k.hi - k.lo + 1, got = G.countIn(arr, k.lo, k.hi), r = rar(k.lo);
      var t = el('button', 'tile' + (got ? '' : ' lock'));
      if (got) paint(t, r);
      t.innerHTML = '<div class="lab">' + k.label + '</div><div class="sub">' + (got ? '<b style="color:var(--c)">' + G.fmt(got) + '</b>' : '0') + ' / ' + bigCount(total) +
        '<div class="bar"><i style="width:' + (got ? Math.max(got / total * 100, 3) : 0) + '%"></i></div></div>';
      t.addEventListener('click', function () { zoomPath = k.path; renderColl(); });
      tiles.appendChild(t);
    });
    body.appendChild(tiles);
  }

  document.querySelectorAll('#viewseg button').forEach(function (b) {
    b.addEventListener('click', function () { view = b.dataset.view; savePrefs(); renderColl(); });
  });
  function savePrefs() { state.prefs = { view: view, open: openFold }; G.save(state); }

  /* 詳細 */
  var toastTimer = null;
  function showToast(html, r) {
    var t = $('toast'); t.innerHTML = html;
    if (r) paint(t, r); else { t.style.removeProperty('--c'); t.style.removeProperty('--g'); }
    t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }
  function showDetail(n) {
    var e = state.counts[String(n)], r = rar(n);
    var info = e
      ? (n === MAX ? '手持ち ' + G.fmt(e.c) + ' 枚(最大値なので繰り上がりません)' : '手持ち ' + e.c + ' / ' + CFG.carryThreshold + '(そろうと ' + G.fmt(n + 1) + ' へ)') + '<br>累計 ' + G.fmt(e.t) + ' 枚 · 初入手 ' + new Date(e.f).toLocaleString('ja-JP')
      : '未解放';
    showToast('<div>' + rarityTag(r) + ' ' + G.digitsOf(n) + '桁 · 出る確率 ' + oneIn(G.probExact(n)) + '</div><div class="n">' + G.fmt(n) + '</div><div>' + info + '</div>', r);
  }

  /* タブ */
  function showTab(name) {
    $('tab-gacha').setAttribute('aria-selected', String(name === 'gacha'));
    $('tab-coll').setAttribute('aria-selected', String(name === 'coll'));
    $('screen-gacha').hidden = name !== 'gacha';
    $('screen-coll').hidden = name !== 'coll';
    if (name === 'coll') renderColl(); else renderGacha();
    window.scrollTo(0, 0);
  }
  $('tab-gacha').addEventListener('click', function () { showTab('gacha'); });
  $('tab-coll').addEventListener('click', function () { showTab('coll'); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });

  /* 起動 */
  if (G.refresh(state, Date.now())) persist();
  renderRates();
  renderGacha();
  tick();
  setInterval(tick, 1000);
})();
