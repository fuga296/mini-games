#!/usr/bin/env node
/*
 * 10年遊んだときの到達状況をモンテカルロで調べる (繰り上がり込み)。
 * 使い方: node num-gacha/tools/simulate.js [人数=2000] [1日の回数=10] [年数=10] [tailStrength]
 * 実際のゲームと同じ logic.js の drawNumber / addNumber を使う。
 */
'use strict';
var G = require('../logic.js');
var players = +process.argv[2] || 2000;
var perDay = +process.argv[3] || 10;
var years = +process.argv[4] || 10;
var cfg = Object.assign({}, G.CONFIG);
if (process.argv[5]) cfg.tailStrength = +process.argv[5];

// 再現性のための軽い PRNG (xorshift32 を2本つないで 53bit に)
function makeRng(seed) {
  var a = (seed * 2654435761) >>> 0 || 1, b = (seed * 40503 + 12345) >>> 0 || 7;
  return function () {
    a ^= a << 13; a ^= a >>> 17; a ^= a << 5; a >>>= 0;
    b ^= b << 7; b ^= b >>> 9; b ^= b << 8; b >>>= 0;
    return ((a >>> 5) * 67108864 + (b >>> 6) + 1) / 9007199254740992;
  };
}

var pullsPerYear = Math.round(perDay * 365.25);
var yearStats = [];
for (var y = 0; y < years; y++) yearStats.push({ uniq: [], maxDigit: [], gotMax: 0, carries: [], topCarry: [], maxNum: [], hist: new Array(17).fill(0) });

for (var p = 0; p < players; p++) {
  var st = G.newState();
  var rng = makeRng(p + 1);
  var maxDigit = 0, gotMax = false, topCarry = 0, maxNum = 0;
  for (var y2 = 0; y2 < years; y2++) {
    for (var i = 0; i < pullsPerYear; i++) {
      var n = G.drawNumber(cfg, rng);
      var ev = G.addNumber(st, n, 0, cfg);
      for (var k = 0; k < ev.length; k++) {
        var m = ev[k].n;
        if (m > maxNum) maxNum = m;
        if (ev[k].via === 'carry' && m > topCarry) topCarry = m;
      }
      if (n === G.MAX) gotMax = true;
    }
    var ys = yearStats[y2];
    ys.uniq.push(Object.keys(st.counts).length);
    var md = G.digitsOf(maxNum);
    ys.maxDigit.push(md);
    ys.hist[md]++;
    if (gotMax) ys.gotMax++;
    ys.carries.push(st.totalCarries);
    ys.topCarry.push(topCarry);
  }
}

function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)]; }
function mean(a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; }

console.log('tailStrength=' + cfg.tailStrength + ' 人数=' + players + ' 1日' + perDay + '回 (年' + pullsPerYear + '回)');
console.log('| 年 | 累計回数 | 種類数(中央値) | 最大桁(中央値) | 16桁到達 | 最大値を引いた | 繰り上がり回数(平均) | 繰り上がりで届いた最大(中央値) |');
console.log('|---|---|---|---|---|---|---|---|');
yearStats.forEach(function (ys, idx) {
  var reach16 = ys.maxDigit.filter(function (d) { return d >= 16; }).length;
  console.log('| ' + (idx + 1) + ' | ' + G.fmt(pullsPerYear * (idx + 1)) + ' | ' + G.fmt(median(ys.uniq)) + ' | ' + median(ys.maxDigit) + ' | ' +
    (100 * reach16 / players).toFixed(1) + '% | ' + (100 * ys.gotMax / players).toFixed(1) + '% | ' + mean(ys.carries).toFixed(0) + ' | ' + median(ys.topCarry) + ' |');
});
var last = yearStats[years - 1];
console.log('\n' + years + '年後の「出た最大の数字の桁数」の分布');
console.log('| 桁 | 人の割合 |');
console.log('|---|---|');
for (var d = 1; d <= 16; d++) if (last.hist[d]) console.log('| ' + d + ' | ' + (100 * last.hist[d] / players).toFixed(1) + '% |');
