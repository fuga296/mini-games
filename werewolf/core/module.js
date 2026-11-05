/*
 * 小さなモジュール定義の仕組み。
 * ブラウザでは <script> で読み込み、globalThis.WW に登録する（file:// でも動くように ES Modules は使わない）。
 * Node では require() で読み込める（テスト用）。
 *
 * define(name, deps, factory)
 *   name    : 登録名（例 'engine'）
 *   deps    : 依存する登録名の配列（例 ['rng']）
 *   factory : (...依存) => 公開する値
 */
(function (g) {
  'use strict';
  var isNode = typeof module !== 'undefined' && module.exports && typeof require === 'function';
  var registry = (g.WW = g.WW || {});
  var nodePaths = {
    rng: '../core/rng.js',
    engine: '../core/engine.js',
    session: '../core/session.js',
    standard: '../rules/standard.js',
    textJa: '../ui/text-ja.js',
  };
  function define(name, deps, factory) {
    var resolved = deps.map(function (d) {
      if (registry[d]) return registry[d];
      if (isNode) return require(require('path').join(__dirname, nodePaths[d]));
      throw new Error('WW: 依存 "' + d + '" が読み込まれていません（' + name + '）');
    });
    var value = factory.apply(null, resolved);
    registry[name] = value;
    return value;
  }
  registry.define = define;
  if (isNode) module.exports = define;
})(typeof globalThis !== 'undefined' ? globalThis : this);
