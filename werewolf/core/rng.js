/*
 * 種つき乱数（mulberry32）。状態は 32bit 整数 1 つなので、ゲーム状態(JSON)にそのまま保存できる。
 * 同じ種なら同じ配役・同じ同数処理になり、テストと再現ができる。
 */
(function (define) {
  define('rng', [], function () {
    'use strict';
    /** state を進めて [0,1) を返す。戻り値は { value, state } */
    function next(state) {
      var t = (state + 0x6d2b79f5) >>> 0;
      var r = t;
      r = Math.imul(r ^ (r >>> 15), r | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      var value = ((r ^ (r >>> 14)) >>> 0) / 4294967296;
      return { value: value, state: t };
    }
    function seedFrom(any) {
      if (typeof any === 'number' && isFinite(any)) return any >>> 0 || 1;
      var s = String(any == null ? Date.now() : any);
      var h = 2166136261;
      for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
      return h >>> 0 || 1;
    }
    return { next: next, seedFrom: seedFrom };
  });
})(typeof module !== 'undefined' && module.exports
  ? function (n, d, f) { module.exports = require('./module.js')(n, d, f); }
  : globalThis.WW.define);
