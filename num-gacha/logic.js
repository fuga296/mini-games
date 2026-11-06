/*
 * NUM GACHA — ロジック (画面に依存しない部分)
 * ブラウザでは window.NumGacha、Node では require('./logic.js') で使える。
 * 設定値の意味・決めた理由は DESIGN.md を参照。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NumGacha = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 出る数字の上限 = JavaScript の安全な整数の最大値 (2^53 - 1) */
  var MAX = Number.MAX_SAFE_INTEGER; // 9007199254740991

  /* ===================== 設定 (ここを変えれば調整できる) ===================== */
  var CONFIG = {
    // 出る桁の確率: 段 k (1桁=1 … 16桁=16、最大値=17) について P(k) ∝ exp(-c·(k-1)^shape)。
    // shape が大きいほど、前半 (小さい桁) は平らで、後半に急に出にくくなる。
    // c は「最大値 (17段目) が 1/maxOdds になる」ように自動で決まる。最大値の専用ルールはない。
    // shape 7 → 1桁 約8.6%、12桁 約4%、16桁 約0.1%
    digitShape: 7,
    // 最大値が出る確率 = 1/maxOdds。10回/日で平均約8年に1回 (DESIGN.md)
    maxOdds: 30000,
    // 1回の更新で回せる回数 (貯めない)
    pullsPerRefresh: 5,
    // 更新間隔 (時間)。24 の約数を想定。端末の現地時刻 0:00 起点で区切る
    refreshHours: 12,
    // 同じ数字を何枚で 1 つ上に繰り上げるか
    carryThreshold: 10,
    // 保存キー (localStorage)
    storageKey: 'numGacha.v1',
    // 履歴を何件残すか
    historySize: 60,
    // レア度: minDigits 桁以上でこのランク (上から判定)。isMax は最大値専用
    rarities: [
      { id: 'MAX', name: 'MAX', label: '最大値', isMax: true, color: '#ffffff', glow: '#ff4fd8', rainbow: true },
      { id: 'LR', name: 'LR', label: 'レジェンド', minDigits: 14, color: '#ff5a7a', glow: '#ff2d55', rainbow: true },
      { id: 'UR', name: 'UR', label: 'ウルトラ', minDigits: 13, color: '#ff8a3d', glow: '#ff6a00' },
      { id: 'SSR', name: 'SSR', label: 'Sスーパー', minDigits: 12, color: '#ffd23f', glow: '#ffb800' },
      { id: 'SR', name: 'SR', label: 'スーパー', minDigits: 10, color: '#c084fc', glow: '#a855f7' },
      { id: 'R', name: 'R', label: 'レア', minDigits: 8, color: '#60a5fa', glow: '#3b82f6' },
      { id: 'UC', name: 'UC', label: 'アンコモン', minDigits: 5, color: '#4ade80', glow: '#22c55e' },
      { id: 'C', name: 'C', label: 'コモン', minDigits: 1, color: '#dfe6f0', glow: '#94a3b8' }
    ]
  };

  /* ===================== 数字のユーティリティ ===================== */
  function digitsOf(n) { return String(n).length; }
  function pow10(k) { return Math.pow(10, k); } // k <= 15 なら正確
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /** d 桁の数の範囲 [lo, hi] (上限は MAX) */
  function digitRange(d) {
    var lo = pow10(d - 1), hi = d >= 16 ? MAX : pow10(d) - 1;
    return [lo, hi];
  }

  function rarityOf(n, cfg) {
    cfg = cfg || CONFIG;
    var d = digitsOf(n);
    for (var i = 0; i < cfg.rarities.length; i++) {
      var r = cfg.rarities[i];
      if (r.isMax) { if (n === MAX) return r; continue; }
      if (d >= r.minDigits) return r;
    }
    return cfg.rarities[cfg.rarities.length - 1];
  }

  /* ===================== 確率 ===================== */
  // 段 k = 1..16 は k 桁 (16桁は最大値を除く)、段 17 = 最大値だけ。
  var TIERS = 17;
  function tierSize(k) {
    if (k === 17) return 1;
    var lo = pow10(k - 1), hi = k === 16 ? MAX - 1 : pow10(k) - 1;
    return hi - lo + 1;
  }
  var wCache = {};
  /** 最大値 (17段目) の確率が 1/maxOdds になる係数 c を二分法で求める */
  function solveC(shape, odds) {
    var lo = -60, hi = 6, i, k;
    for (i = 0; i < 200; i++) {
      var m = (lo + hi) / 2, c = Math.exp(m), sum = 0;
      for (k = 0; k < TIERS; k++) sum += Math.exp(-c * Math.pow(k, shape));
      if (Math.exp(-c * Math.pow(TIERS - 1, shape)) / sum > 1 / odds) lo = m; else hi = m;
    }
    return Math.exp((lo + hi) / 2);
  }
  function tierWeights(cfg) { // 各段の確率 w[0..16] (合計 1)
    var key = cfg.digitShape + '/' + cfg.maxOdds;
    if (wCache[key]) return wCache[key];
    var c = solveC(cfg.digitShape, cfg.maxOdds), w = [], sum = 0, k;
    for (k = 0; k < TIERS; k++) { var x = Math.exp(-c * Math.pow(k, cfg.digitShape)); w.push(x); sum += x; }
    for (k = 0; k < TIERS; k++) w[k] /= sum;
    return (wCache[key] = { w: w, sum: 1, c: c });
  }
  /** 段 k に入る確率 (k = 1..17) */
  function tierProb(k, cfg) {
    cfg = cfg || CONFIG;
    var t = tierWeights(cfg);
    return t.w[k - 1] / t.sum;
  }
  function tierOf(n) { return n >= MAX ? 17 : digitsOf(n); }
  /** ちょうど n が出る確率 */
  function probExact(n, cfg) { return tierProb(tierOf(n), cfg) / tierSize(tierOf(n)); }
  /** d 桁 (最大値を除く) のどれかが出る確率 */
  function probDigits(d, cfg) { return tierProb(d, cfg); }

  /** レア度ごとの確率表 */
  function rarityTable(cfg) {
    cfg = cfg || CONFIG;
    var rows = [], rs = cfg.rarities, upper = 16; // 上の段の最小桁 - 1 まで
    for (var i = 0; i < rs.length; i++) {
      var r = rs[i];
      if (r.isMax) { rows.push({ rarity: r, lo: MAX, hi: MAX, p: tierProb(17, cfg) }); continue; }
      var p = 0;
      for (var d = r.minDigits; d <= upper; d++) p += tierProb(d, cfg);
      rows.push({ rarity: r, lo: pow10(r.minDigits - 1), hi: upper >= 16 ? MAX - 1 : pow10(upper) - 1, p: p });
      upper = r.minDigits - 1;
    }
    return rows;
  }

  /* ===================== 抽選 ===================== */
  /** (0, 1] の一様乱数 (53bit)。rng を渡せばそれを使う */
  function randomUnit(rng) {
    if (rng) { var u = rng(); return u > 0 ? u : Number.MIN_VALUE; }
    var a, b;
    var c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
    if (c) {
      var buf = new Uint32Array(2);
      c.getRandomValues(buf);
      a = buf[0] >>> 5; b = buf[1] >>> 6;
    } else {
      a = Math.floor(Math.random() * 134217728); b = Math.floor(Math.random() * 67108864);
    }
    return (a * 67108864 + b + 1) / 9007199254740992; // (k+1) / 2^53
  }

  /** 1 回抽選して数字を返す。まず段 (桁) を等比の確率で選び、同じ桁の中は一様に選ぶ */
  function drawNumber(cfg, rng) {
    cfg = cfg || CONFIG;
    var t = tierWeights(cfg);
    var x = randomUnit(rng) * t.sum, k = 1;
    for (; k < TIERS; k++) { if (x <= t.w[k - 1]) break; x -= t.w[k - 1]; }
    if (k === 17) return MAX;
    var lo = pow10(k - 1), size = tierSize(k);
    var off = Math.ceil(randomUnit(rng) * size) - 1; // 0 .. size-1
    if (off < 0) off = 0; if (off > size - 1) off = size - 1;
    return lo + off;
  }

  /* ===================== 状態 ===================== */
  function newState() {
    return {
      v: 1,
      period: null,      // 最後に補充した更新番号 (大きくなる方向にしか進めない)
      pullsLeft: 0,
      counts: {},        // "n": { c: 手持ち(0..threshold-1), t: 累計入手, f: 初入手時刻 }
      totalPulls: 0,
      totalCarries: 0,
      history: [],       // 新しい順 { n, at, ev: [{n,isNew,via}] }
      prefs: {}
    };
  }

  /** 端末の現地時刻で区切った更新番号 */
  function periodIndex(nowMs, cfg) {
    cfg = cfg || CONFIG;
    var tz = new Date(nowMs).getTimezoneOffset() * 60000;
    return Math.floor((nowMs - tz) / (cfg.refreshHours * 3600000));
  }
  /** 次の更新時刻 (ms) */
  function nextRefreshAt(nowMs, cfg) {
    cfg = cfg || CONFIG;
    var span = cfg.refreshHours * 3600000;
    var idx = periodIndex(nowMs, cfg);
    var t = (idx + 1) * span;
    // 現地時刻→UTC (夏時間の境目でずれないよう2回補正)
    var guess = t + new Date(t).getTimezoneOffset() * 60000;
    guess = t + new Date(guess).getTimezoneOffset() * 60000;
    return guess;
  }

  /** 更新を反映。新しい更新に入っていれば回数を満タンに戻す (貯めない) */
  function refresh(state, nowMs, cfg) {
    cfg = cfg || CONFIG;
    var idx = periodIndex(nowMs, cfg);
    if (state.period === null || idx > state.period) {
      state.period = idx;
      state.pullsLeft = cfg.pullsPerRefresh;
      return true;
    }
    // 時計が戻った場合 (idx < period) は何もしない
    return false;
  }

  /** 数字を 1 枚加え、繰り上がりを連鎖させる。起きたことの一覧を返す */
  function addNumber(state, n, nowMs, cfg) {
    cfg = cfg || CONFIG;
    var events = [];
    var cur = n, via = 'pull';
    for (;;) {
      var key = String(cur);
      var e = state.counts[key];
      var isNew = !e;
      if (!e) e = state.counts[key] = { c: 0, t: 0, f: nowMs || 0 };
      e.c++; e.t++;
      events.push({ n: cur, isNew: isNew, via: via });
      if (e.c >= cfg.carryThreshold && cur < MAX) {
        e.c -= cfg.carryThreshold;
        cur = cur + 1;
        via = 'carry';
        state.totalCarries++;
        continue;
      }
      break;
    }
    return events;
  }

  /** 1 回まわす。回数がなければ null */
  function pull(state, nowMs, cfg, rng) {
    cfg = cfg || CONFIG;
    refresh(state, nowMs, cfg);
    if (state.pullsLeft <= 0) return null;
    state.pullsLeft--;
    state.totalPulls++;
    var n = drawNumber(cfg, rng);
    var ev = addNumber(state, n, nowMs, cfg);
    state.history.unshift({ n: n, at: nowMs, ev: ev });
    if (state.history.length > cfg.historySize) state.history.length = cfg.historySize;
    return { n: n, events: ev };
  }

  /* ===================== 保存 ===================== */
  function load(cfg) {
    cfg = cfg || CONFIG;
    try {
      var s = localStorage.getItem(cfg.storageKey);
      if (s) {
        var st = JSON.parse(s);
        var base = newState();
        for (var k in base) if (!(k in st)) st[k] = base[k];
        return st;
      }
    } catch (e) { /* 保存できない環境でも遊べる */ }
    return newState();
  }
  function save(state, cfg) {
    cfg = cfg || CONFIG;
    try { localStorage.setItem(cfg.storageKey, JSON.stringify(state)); return true; } catch (e) { return false; }
  }

  /** 解放済みの数字を昇順に */
  function unlockedSorted(state) {
    return Object.keys(state.counts).map(Number).sort(function (a, b) { return a - b; });
  }
  /** 昇順配列から lo..hi に入る個数 */
  function lowerBound(arr, x) {
    var l = 0, h = arr.length;
    while (l < h) { var m = (l + h) >> 1; if (arr[m] < x) l = m + 1; else h = m; }
    return l;
  }
  function countIn(arr, lo, hi) { return lowerBound(arr, hi + 1) - lowerBound(arr, lo); }

  return {
    MAX: MAX, CONFIG: CONFIG,
    digitsOf: digitsOf, pow10: pow10, fmt: fmt, digitRange: digitRange, rarityOf: rarityOf,
    tierProb: tierProb, tierSize: tierSize, probExact: probExact, probDigits: probDigits, rarityTable: rarityTable,
    randomUnit: randomUnit, drawNumber: drawNumber,
    newState: newState, periodIndex: periodIndex, nextRefreshAt: nextRefreshAt, refresh: refresh,
    addNumber: addNumber, pull: pull, load: load, save: save,
    unlockedSorted: unlockedSorted, lowerBound: lowerBound, countIn: countIn
  };
});
