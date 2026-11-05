/*
 * セッション：エンジンを「誰が操作しているか」付きで包む層。
 *
 * 画面はエンジンを直接触らず、このインターフェースだけを使う。
 *   session.view(viewerId)          見てよい情報
 *   session.dispatch(actor, cmd)    操作（actor の権限を確認してからエンジンへ）
 *   session.subscribe(fn)           変化の通知
 *   session.snapshot()              保存用の状態(JSON)
 *
 * ここにあるのは「1台の端末の中で完結する」LocalSession だけ。
 * 各自の端末で遊ぶ形にするときは、同じインターフェースを持つ RemoteSession を作り、
 * dispatch をサーバー(または親機)へ送り、view を受け取るようにする（DESIGN.md「通信の差し込み口」）。
 *
 * actor（操作者）の種類
 *   { kind:'player', playerId }  本人として操作（自分の分しかできない）
 *   { kind:'gm' }                司会（誰の代わりにも入力でき、段階を進められる）
 *   { kind:'host' }              スマホを回す形の端末そのもの（段階を進めるだけ。本人操作は player で行う）
 */
(function (define) {
  define('session', ['engine'], function (E) {
    'use strict';

    function authorize(actor, cmd) {
      if (!actor || !actor.kind) return '操作者が不明です';
      if (actor.kind === 'gm') return null;
      if (cmd.type === 'advance') return actor.kind === 'host' ? null : '段階を進められるのは親機か司会だけです';
      if (actor.kind === 'player') {
        if (cmd.playerId !== actor.playerId) return '自分の分しか操作できません';
        return null;
      }
      return 'この操作はできません';
    }

    function createLocalSession(ruleset, state) {
      var listeners = [];
      var current = state;
      return {
        ruleset: ruleset,
        view: function (viewerId) { return E.view(current, ruleset, viewerId); },
        dispatch: function (actor, cmd) {
          var err = authorize(actor, cmd);
          if (err) return { ok: false, error: err };
          var r = E.dispatch(current, ruleset, cmd);
          if (r.ok) {
            current = r.state;
            listeners.forEach(function (fn) { fn(r.events); });
          }
          return { ok: r.ok, error: r.error, events: r.events };
        },
        subscribe: function (fn) {
          listeners.push(fn);
          return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
        },
        snapshot: function () { return E.clone(current); },
      };
    }

    return { createLocalSession: createLocalSession, authorize: authorize };
  });
})(typeof module !== 'undefined' && module.exports
  ? function (n, d, f) { module.exports = require('./module.js')(n, d, f); }
  : globalThis.WW.define);
