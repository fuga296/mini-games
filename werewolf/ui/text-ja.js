/*
 * 日本語の文言。記録(event)を文章にする関数と、司会の読み上げ台本。
 * DOM には触らないので、モバイルアプリへ移すときもそのまま使える（または言語ごとに差し替える）。
 */
(function (define) {
  define('textJa', [], function () {
    'use strict';

    function nameOf(view, id) {
      var p = view.players.filter(function (x) { return x.id === id; })[0];
      return p ? p.name : id;
    }
    function roleName(rs, id) { return rs.roles[id] ? rs.roles[id].name : '？'; }
    function resultName(r) { return r === 'werewolf' ? '人狼' : '人間'; }
    function names(view, ids) { return ids.map(function (id) { return nameOf(view, id); }).join('、'); }
    var causes = { attack: '襲撃', curse: '呪殺', execution: '処刑' };

    /** 記録1件を文章に。null は表示しない記録 */
    function formatEvent(ev, view, rs) {
      var d = ev.data;
      switch (ev.type) {
        case 'gameStart': {
          var parts = rs.roleOrder.filter(function (r) { return d.roleCounts[r]; })
            .map(function (r) { return roleName(rs, r) + d.roleCounts[r]; });
          return 'ゲーム開始（' + parts.join('・') + '）';
        }
        case 'roleAssigned':
          return (view.viewer === d.playerId ? 'あなた' : nameOf(view, d.playerId)) + 'の役職は「' + roleName(rs, d.roleId) + '」';
        case 'nightStart': return null;
        case 'divineResult':
          return (d.oracle ? 'お告げ：' : '占い：') + nameOf(view, d.targetId) + ' は「' + resultName(d.result) + '」';
        case 'mediumResult': return '霊媒：' + nameOf(view, d.targetId) + ' は「' + resultName(d.result) + '」';
        case 'guarded': return '護衛：' + nameOf(view, d.actorId) + ' → ' + nameOf(view, d.targetId);
        case 'attackTarget': return '襲撃先：' + (d.targetId ? nameOf(view, d.targetId) : 'なし');
        case 'attackBlocked': return '襲撃失敗（' + (d.by === 'guard' ? '護衛' : '耐性') + '）：' + nameOf(view, d.targetId);
        case 'death': return '死亡（' + (causes[d.cause] || d.cause) + '）：' + nameOf(view, d.playerId);
        case 'roleRevealed': return nameOf(view, d.playerId) + ' の役職は「' + roleName(rs, d.roleId) + '」でした';
        case 'dawn': return d.deaths.length ? '朝：' + names(view, d.deaths) + ' が無残な姿で発見されました' : '朝：昨夜の犠牲者はいませんでした';
        case 'dayStart': return null;
        case 'voteStart': return d.runoff ? '決選投票：' + names(view, d.candidates) : null;
        case 'voteResult': {
          var c = Object.keys(d.counts).map(function (id) { return nameOf(view, id) + ' ' + d.counts[id] + '票'; });
          return (d.runoff ? '決選投票の結果：' : '投票の結果：') + (c.join('、') || '投票なし');
        }
        case 'voteBallots': return null;
        case 'voteTie': return '同数のため決選投票：' + names(view, d.candidates);
        case 'voteTieRandom': return '同数のためランダムで決定：' + nameOf(view, d.chosen);
        case 'executed': return nameOf(view, d.playerId) + ' が処刑されました';
        case 'noExecution': return '今日は誰も処刑されませんでした';
        case 'gameEnd': return '決着：' + d.teams.map(function (t) { return rs.teams[t] ? rs.teams[t].name : t; }).join('・') + 'の勝利（' + d.reason + '）';
        default: return null;
      }
    }

    /** 誰が誰に投票したか（公開設定のとき） */
    function ballotLines(ev, view) {
      if (!ev.data.ballots) return [];
      return Object.keys(ev.data.ballots).map(function (v) {
        return nameOf(view, v) + ' → ' + nameOf(view, ev.data.ballots[v]);
      });
    }

    var actionText = {
      attack: { prompt: '今夜襲撃する人を選んでください', done: '襲撃先' },
      divine: { prompt: '占う人を選んでください', done: '占い先' },
      guard: { prompt: '今夜守る人を選んでください', done: '護衛先' },
    };

    /**
     * 司会の夜の台本。役職ごとに呼ぶ順で並べる。
     * 生存者がいない役職も呼ぶ（呼ばないと「その役職はもう死んでいる」とばれるため）。
     */
    var nightCalls = [
      { roleId: 'werewolf', group: true, actionId: 'attack',
        open: '人狼の人は目を開けて、仲間を確認してください。', act: '今夜襲撃する人を指差してください。', close: '人狼の人は目を閉じてください。' },
      { roleId: 'seer', actionId: 'divine',
        open: '占い師の人は目を開けてください。', act: '占いたい人を指差してください。（結果を手で示します：親指上＝人間／下＝人狼）', close: '占い師の人は目を閉じてください。' },
      { roleId: 'knight', actionId: 'guard',
        open: '騎士の人は目を開けてください。', act: '今夜守る人を指差してください。', close: '騎士の人は目を閉じてください。' },
      { roleId: 'medium', actionId: null,
        open: '霊媒師の人は目を開けてください。', act: '今日処刑された人の結果を手で示します。（親指上＝人間／下＝人狼）', close: '霊媒師の人は目を閉じてください。' },
    ];

    var script = {
      revealGM: '役職を配ります。スマホを順番に回して、自分の役職だけを確認してください。',
      nightStart: '夜になりました。全員目を閉じて、顔を伏せてください。',
      nightEnd: '朝になりました。全員顔を上げてください。',
      dayStart: '話し合いを始めてください。',
      voteStart: '投票の時間です。「せーの」で、処刑したい人を一斉に指差してください。',
    };

    return {
      formatEvent: formatEvent,
      ballotLines: ballotLines,
      nameOf: nameOf,
      roleName: roleName,
      resultName: resultName,
      actionText: actionText,
      nightCalls: nightCalls,
      script: script,
      dayLabel: function (d) { return d <= 1 ? '初日' : d + '日目'; },
    };
  });
})(typeof module !== 'undefined' && module.exports
  ? function (n, d, f) { module.exports = require('../core/module.js')(n, d, f); }
  : globalThis.WW.define);
