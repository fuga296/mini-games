/*
 * パワーワード人狼：標準ルールの上に差し込む変則ルール。
 *
 * ・毎晩、生きている人狼にパワーワードが配られる（本人たちにだけ見える）。
 * ・人狼は、次の昼の話し合いの中で、そのワードを自然に使わなければならない。
 * ・次の朝（次の夜が明けたとき）に、前日のワードが全員に公開される。
 * ・ゲームが終わったときは、使われなかった最後のワードも公開される。
 *
 * エンジンは変えていない。使った差し込み口は次のとおり。
 *   phases.night.enter / phases.day.enter / phases.end.enter … ワードを配る・公開する
 *   ctx.emit(visibleTo)          … 誰に見せるかを記録ごとに指定
 *   state.extra / defaultConfig … 配った記録と設定
 */
(function (define) {
  define('powerword', ['standard', 'powerWords'], function (S, W) {
    'use strict';

    var baseNight = S.phases.night;
    var baseDay = S.phases.day;
    var baseEnd = S.phases.end;

    /** 候補から重複しないよう1つ引く。使い切ったら使用済みを戻して引き直す */
    function draw(ctx) {
      var ex = ctx.state.extra;
      var max = ctx.config.powerWordMaxLevel;
      var pool = W.words.filter(function (w) { return w.level <= max; });
      var unused = pool.filter(function (w) { return ex.usedWords.indexOf(w.text) < 0; });
      if (!unused.length) { ex.usedWords = []; unused = pool; }
      var w = ctx.pick(unused);
      ex.usedWords.push(w.text);
      return { text: w.text, kind: w.kind };
    }

    /** 公開する記録には、誰がどのワードだったか（＝人狼の正体）を含めない。ワードだけを重複なしで並べる */
    function reveal(ctx, rec, final) {
      if (!rec) return;
      var seen = {};
      var list = [];
      Object.keys(rec.words).forEach(function (id) {
        var w = rec.words[id];
        if (!seen[w.text]) { seen[w.text] = true; list.push({ text: w.text, kind: w.kind }); }
      });
      list.sort(function (a, b) { return a.text < b.text ? -1 : a.text > b.text ? 1 : 0; });
      ctx.emit('powerWordReveal', { words: list, forDay: rec.day, final: !!final }, 'all');
    }

    var night = Object.assign({}, baseNight, {
      enter: function (ctx) {
        var ex = ctx.state.extra;
        ex.usedWords = ex.usedWords || [];
        // 前の昼に使われたワードは、次の朝に公開するため控えに回す
        ex.pendingReveal = ex.activeWords || null;
        ex.activeWords = null;
        baseNight.enter(ctx);
        var wolves = S.helpers.wolvesAlive(ctx);
        if (!wolves.length) return;
        var shared = !!ctx.config.powerWordShared;
        var rec = { day: ctx.state.day, shared: shared, words: {} };
        if (shared) {
          var one = draw(ctx);
          wolves.forEach(function (p) { rec.words[p.id] = one; });
          ctx.emit('powerWordGiven', { words: rec.words, shared: true }, wolves.map(function (p) { return p.id; }));
        } else {
          wolves.forEach(function (p) {
            rec.words[p.id] = draw(ctx);
            var mine = {}; mine[p.id] = rec.words[p.id];
            ctx.emit('powerWordGiven', { words: mine, shared: false }, [p.id]);
          });
        }
        ex.activeWords = rec;
      },
    });

    var day = Object.assign({}, baseDay, {
      enter: function (ctx) {
        baseDay.enter(ctx);
        var ex = ctx.state.extra;
        reveal(ctx, ex.pendingReveal, false);
        ex.pendingReveal = null;
      },
    });

    var end = Object.assign({}, baseEnd, {
      enter: function (ctx) {
        var ex = ctx.state.extra;
        reveal(ctx, ex.pendingReveal, true);
        reveal(ctx, ex.activeWords, true);
        ex.pendingReveal = null;
        ex.activeWords = null;
      },
    });

    return S.extend({
      id: 'powerword',
      name: 'パワーワード人狼',
      roles: {
        werewolf: Object.assign({}, S.roles.werewolf, {
          description: '夜に仲間と相談して1人を襲撃します。さらに、毎晩配られる「パワーワード」を、次の昼の話し合いで自然に使わなければなりません。ワードは翌朝に全員へ公開されます。',
        }),
      },
      defaultConfig: {
        powerWordShared: true,    // true: 人狼全員が同じワード / false: 人狼ごとに別のワード
        powerWordMaxLevel: 3,     // 使うワードの最大の難しさ（1〜3）
      },
      phases: { night: night, day: day, end: end },
    });
  });
})(typeof module !== 'undefined' && module.exports
  ? function (n, d, f) { module.exports = require('../core/module.js')(n, d, f); }
  : globalThis.WW.define);
