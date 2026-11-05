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
    // 分布の形: P(X >= n) = n^(-alpha)。小さいほど大きい数字が出やすい。
    // 0.28 → 最大値 1/29,400 回。10回/日で平均約8年に1回 (DESIGN.md)
    alpha: 0.28,
    // 上限を超えた抽選の扱い: 'clamp' = 最大値に張り付く / 'reroll' = 引き直し
    overflow: 'clamp',
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
      { id: 'LR', name: 'LR', label: 'レジェンド', minDigits: 13, color: '#ff5a7a', glow: '#ff2d55', rainbow: true },
      { id: 'UR', name: 'UR', label: 'ウルトラ', minDigits: 9, color: '#ff8a3d', glow: '#ff6a00' },
      { id: 'SSR', name: 'SSR', label: 'Sスーパー', minDigits: 6, color: '#ffd23f', glow: '#ffb800' },
      { id: 'SR', name: 'SR', label: 'スーパー', minDigits: 4, color: '#c084fc', glow: '#a855f7' },
      { id: 'R', name: 'R', label: 'レア', minDigits: 3, color: '#60a5fa', glow: '#3b82f6' },
      { id: 'UC', name: 'UC', label: 'アンコモン', minDigits: 2, color: '#4ade80', glow: '#22c55e' },
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
  /** P(X >= n) (n >= 1) */
  function tail(n, cfg) {
    cfg = cfg || CONFIG;
    if (n <= 1) return 1;
    if (n > MAX) return 0;
    var p = Math.pow(n, -cfg.alpha);
    if (cfg.overflow === 'reroll') {
      var pm = Math.pow(MAX + 1, -cfg.alpha); // 上限超え分を除いて正規化
      return (p - pm) / (1 - pm);
    }
    return p; // clamp: 上限超えはすべて MAX に乗るので tail(MAX) = MAX^-alpha
  }
  /** ちょうど n が出る確率 */
  function probExact(n, cfg) { return tail(n, cfg) - tail(n + 1, cfg); }
  /** lo..hi のどれかが出る確率 */
  function probRange(lo, hi, cfg) { return tail(lo, cfg) - tail(hi + 1, cfg); }

  /** レア度ごとの確率表 */
  function rarityTable(cfg) {
    cfg = cfg || CONFIG;
    var rows = [];
    var rs = cfg.rarities;
    var prevMin = 17; // 上の段の minDigits
    for (var i = 0; i < rs.length; i++) {
      var r = rs[i];
      if (r.isMax) { rows.push({ rarity: r, lo: MAX, hi: MAX, p: probExact(MAX, cfg) }); continue; }
      var lo = pow10(r.minDigits - 1);
      var hi = prevMin >= 17 ? MAX - 1 : pow10(prevMin - 1) - 1;
      if (prevMin >= 17) hi = MAX - 1; // 最上位帯は最大値を除く
      rows.push({ rarity: r, lo: lo, hi: hi, p: probRange(lo, hi, cfg) });
      prevMin = r.minDigits;
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

  /** 1 回抽選して数字を返す。逆関数法: X = floor(U^(-1/alpha)) */
  function drawNumber(cfg, rng) {
    cfg = cfg || CONFIG;
    for (;;) {
      var u = randomUnit(rng);
      var raw = Math.pow(u, -1 / cfg.alpha);
      if (raw >= MAX) {
        // floor(raw) >= MAX: clamp なら MAX、reroll なら raw >= MAX+1 のとき引き直し
        if (cfg.overflow === 'reroll' && raw >= MAX + 1) continue;
        return MAX;
      }
      var n = Math.floor(raw);
      return n < 1 ? 1 : n;
    }
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
    tail: tail, probExact: probExact, probRange: probRange, rarityTable: rarityTable,
    randomUnit: randomUnit, drawNumber: drawNumber,
    newState: newState, periodIndex: periodIndex, nextRefreshAt: nextRefreshAt, refresh: refresh,
    addNumber: addNumber, pull: pull, load: load, save: save,
    unlockedSorted: unlockedSorted, lowerBound: lowerBound, countIn: countIn
  };
});
