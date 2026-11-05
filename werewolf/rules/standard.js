/*
 * 普通の人狼（標準ルールセット）。
 * すべてデータと小さな関数で書き、エンジン(core/engine.js)は変えずに差し替えられる。
 * 変則人狼は、このファイルを土台に extend() で上書きして作る想定（DESIGN.md 参照）。
 */
(function (define) {
  define('standard', ['engine'], function (E) {
    'use strict';

    // ---------------- 陣営 ----------------
    var teams = {
      village: { id: 'village', name: '村人陣営' },
      werewolf: { id: 'werewolf', name: '人狼陣営' },
      fox: { id: 'fox', name: '妖狐陣営' },
    };

    // ---------------- 役職 ----------------
    // countAs  : 人数の数え方（'wolf' = 人狼として数える / 'human' = 人間として数える / 'none' = 数えない）
    // divine   : 占いの結果 / medium : 霊媒の結果（'werewolf' | 'human'）
    // revealGroup : 同じ値の人どうしは最初から互いの役職を知る
    // actions  : 使える行動 ID
    var roles = {
      villager: {
        id: 'villager', name: '村人', team: 'village', countAs: 'human', divine: 'human', medium: 'human',
        actions: [], description: '特別な能力はありません。話し合いで人狼を見つけて処刑しましょう。',
      },
      werewolf: {
        id: 'werewolf', name: '人狼', team: 'werewolf', countAs: 'wolf', divine: 'werewolf', medium: 'werewolf',
        revealGroup: 'wolves', actions: ['attack'],
        description: '夜に仲間と相談して1人を襲撃します。人狼の数が人間の数以上になれば勝ちです。',
      },
      seer: {
        id: 'seer', name: '占い師', team: 'village', countAs: 'human', divine: 'human', medium: 'human',
        actions: ['divine'], description: '夜に1人を占い、人狼かどうかを知ります。',
      },
      medium: {
        id: 'medium', name: '霊媒師', team: 'village', countAs: 'human', divine: 'human', medium: 'human',
        actions: [], passive: 'medium', description: '夜になると、その日に処刑された人が人狼だったかどうかを知ります。',
      },
      knight: {
        id: 'knight', name: '騎士', team: 'village', countAs: 'human', divine: 'human', medium: 'human',
        actions: ['guard'], description: '夜に自分以外の1人を人狼の襲撃から守ります。',
      },
      madman: {
        id: 'madman', name: '狂人', team: 'werewolf', countAs: 'human', divine: 'human', medium: 'human',
        actions: [], description: '人間ですが人狼の味方です。人狼が勝てばあなたも勝ちです。人狼が誰かは知りません。',
      },
      fox: {
        id: 'fox', name: '妖狐', team: 'fox', countAs: 'human', divine: 'human', medium: 'human',
        attackImmune: true, diesWhenDivined: true, actions: [],
        description: '襲撃では死にませんが、占われると死にます。ゲーム終了時に生き残っていれば単独で勝ちです。',
      },
    };

    // 配役表に出す順
    var roleOrder = ['werewolf', 'madman', 'seer', 'medium', 'knight', 'fox', 'villager'];

    // ---------------- 既定の設定（すべて画面から変更可） ----------------
    var defaultConfig = {
      discussionSeconds: 180,      // 昼の話し合い時間（秒）
      firstNightAttack: false,     // 初日の夜に襲撃があるか
      firstNightDivine: 'free',    // 初日の占い: 'free'（自由に占う）| 'none'（なし）| 'randomWhite'（ランダムな人間を1人知らされる）
      consecutiveGuard: false,     // 同じ人を2夜続けて守れるか
      selfGuard: false,            // 騎士が自分を守れるか
      allowSelfVote: false,        // 自分に投票できるか
      tieRule: 'runoff',           // 同数のとき: 'runoff'（決選投票）| 'random' | 'none'（処刑なし）
      runoffTie: 'random',         // 決選投票も同数のとき: 'random' | 'none'
      aggregateTie: 'random',      // 人狼の襲撃先が割れたとき: 'random' | 'none'（襲撃なし）
      voteReveal: 'open',          // 投票結果: 'open'（誰が誰に入れたか）| 'count'（票数のみ）
      revealRoleOnDeath: false,    // 死んだ人の役職を公開するか
    };

    // 人数ごとのおすすめ配役（変更可）。合計が人数になるよう村人で調整する。
    var presets = {
      4: { werewolf: 1, seer: 1 },
      5: { werewolf: 1, seer: 1, madman: 1 },
      6: { werewolf: 1, seer: 1, knight: 1, madman: 1 },
      7: { werewolf: 2, seer: 1, knight: 1 },
      8: { werewolf: 2, seer: 1, medium: 1, knight: 1 },
      9: { werewolf: 2, seer: 1, medium: 1, knight: 1, madman: 1 },
      10: { werewolf: 2, seer: 1, medium: 1, knight: 1, madman: 1 },
      11: { werewolf: 2, seer: 1, medium: 1, knight: 1, madman: 1 },
      12: { werewolf: 3, seer: 1, medium: 1, knight: 1, madman: 1 },
      13: { werewolf: 3, seer: 1, medium: 1, knight: 1, madman: 1 },
      14: { werewolf: 3, seer: 1, medium: 1, knight: 1, madman: 1, fox: 1 },
      15: { werewolf: 3, seer: 1, medium: 1, knight: 1, madman: 1, fox: 1 },
    };
    var minPlayers = 4;
    var maxPlayers = 20;

    function presetFor(n) {
      var keys = Object.keys(presets).map(Number).sort(function (a, b) { return a - b; });
      var k = keys[0];
      keys.forEach(function (x) { if (x <= n) k = x; });
      var base = Object.assign({}, presets[k]);
      var used = 0;
      Object.keys(base).forEach(function (r) { used += base[r]; });
      base.villager = (base.villager || 0) + Math.max(0, n - used);
      return base;
    }

    /** 配役の妥当性。問題があれば日本語の理由、なければ null */
    function validateRoles(ruleset, n, counts) {
      var total = 0, wolves = 0, humans = 0;
      Object.keys(counts).forEach(function (r) {
        var c = counts[r] || 0;
        if (c < 0) return;
        if (c && !ruleset.roles[r]) return;
        total += c;
        if (c && ruleset.roles[r].countAs === 'wolf') wolves += c;
        else if (c && ruleset.roles[r].countAs === 'human') humans += c;
      });
      if (n < ruleset.minPlayers) return ruleset.minPlayers + '人以上必要です';
      if (n > ruleset.maxPlayers) return ruleset.maxPlayers + '人までです';
      if (total !== n) return '配役の合計(' + total + ')が人数(' + n + ')と合いません';
      if (wolves < 1) return '人狼が1人以上必要です';
      if (wolves >= humans) return '最初から人狼が人間以上いるとすぐ終わってしまいます';
      return null;
    }

    // ---------------- 便利関数 ----------------
    function wolvesAlive(ctx) { return ctx.alive().filter(function (p) { return ctx.role(p).countAs === 'wolf'; }); }
    function humansAlive(ctx) { return ctx.alive().filter(function (p) { return ctx.role(p).countAs === 'human'; }); }
    function others(ctx, me) { return ctx.alive().filter(function (p) { return p.id !== me.id; }); }
    function sameGroup(ctx, a, b) {
      var ra = ctx.role(a), rb = ctx.role(b);
      return !!(ra && rb && ra.revealGroup && ra.revealGroup === rb.revealGroup);
    }
    function kill(ctx, p, cause, visibleTo) {
      if (!p || !p.alive) return false;
      p.alive = false;
      ctx.emit('death', { playerId: p.id, cause: cause }, visibleTo || 'gm');
      if (ctx.state.config.revealRoleOnDeath) ctx.emit('roleRevealed', { playerId: p.id, roleId: p.roleId }, 'all');
      return true;
    }

    // ---------------- 行動 ----------------
    // priority が小さいほど先に解決: 護衛(10) → 占い(20) → 襲撃(30)
    var actions = {
      guard: {
        id: 'guard', name: '護衛', phases: ['night'], priority: 10,
        available: function (ctx) { return ctx.state.day > 1 || ctx.config.firstNightAttack; },
        targets: function (ctx, me) {
          return ctx.alive().filter(function (p) {
            if (p.id === me.id && !ctx.config.selfGuard) return false;
            if (!ctx.config.consecutiveGuard && me.memory.lastGuard === p.id) return false;
            return true;
          });
        },
        resolve: function (ctx, inst, night) {
          night.protected[inst.targetId] = true;
          ctx.player(inst.actorId).memory.lastGuard = inst.targetId;
          ctx.emit('guarded', { actorId: inst.actorId, targetId: inst.targetId }, 'gm');
        },
      },
      divine: {
        id: 'divine', name: '占い', phases: ['night'], priority: 20, changeable: false,
        available: function (ctx) { return ctx.state.day > 1 || ctx.config.firstNightDivine === 'free'; },
        targets: function (ctx, me) { return others(ctx, me); },
        // 結果はその場で本人に見せる（スマホを回す遊び方のため）。呪殺などの効果は夜の解決時。
        instant: function (ctx, me, targetId) {
          var t = ctx.player(targetId);
          ctx.emit('divineResult', { actorId: me.id, targetId: targetId, result: ctx.role(t).divine }, [me.id]);
        },
        resolve: function (ctx, inst, night) {
          var t = ctx.player(inst.targetId);
          if (t && t.alive && ctx.role(t).diesWhenDivined) night.deaths.push({ playerId: t.id, cause: 'curse' });
        },
      },
      attack: {
        id: 'attack', name: '襲撃', phases: ['night'], priority: 30, aggregate: 'majority', shareChoices: true,
        available: function (ctx) { return ctx.state.day > 1 || ctx.config.firstNightAttack; },
        targets: function (ctx, me) {
          return ctx.alive().filter(function (p) { return p.id !== me.id && !sameGroup(ctx, me, p); });
        },
        resolve: function (ctx, inst, night) {
          var t = ctx.player(inst.targetId);
          ctx.emit('attackTarget', { actorIds: inst.actorIds, targetId: inst.targetId }, 'gm');
          if (!t || !t.alive) return;
          if (night.protected[t.id]) { ctx.emit('attackBlocked', { targetId: t.id, by: 'guard' }, 'gm'); return; }
          if (ctx.role(t).attackImmune) { ctx.emit('attackBlocked', { targetId: t.id, by: 'immune' }, 'gm'); return; }
          night.deaths.push({ playerId: t.id, cause: 'attack' });
        },
      },
    };

    // ---------------- 段階 ----------------
    function dayLabel(d) { return d <= 1 ? '初日' : d + '日目'; }

    var phases = {
      reveal: {
        id: 'reveal', label: '役職の確認',
        acks: function (ctx) { return ctx.players(); },
        enter: function (ctx) {
          ctx.players().forEach(function (p) {
            ctx.emit('roleAssigned', { playerId: p.id, roleId: p.roleId }, [p.id]);
          });
        },
        next: function () { return 'night'; },
      },
      night: {
        id: 'night', label: function (ctx) { return dayLabel(ctx.state.day) + 'の夜'; },
        acceptsActions: true,
        checkWin: true,
        enter: function (ctx) {
          if (ctx.state.day === 0) ctx.state.day = 1;
          ctx.emit('nightStart', {}, 'all');
          // 霊媒：今日の処刑者の結果を知る
          var ex = ctx.state.extra.lastExecuted;
          if (ex) {
            var t = ctx.player(ex);
            ctx.alive().forEach(function (p) {
              if (ctx.role(p).passive === 'medium') {
                ctx.emit('mediumResult', { actorId: p.id, targetId: t.id, result: ctx.role(t).medium }, [p.id]);
              }
            });
          }
          ctx.state.extra.lastExecuted = null;
          // 初日のお告げ（ランダムな人間を1人知らされる）
          if (ctx.state.day === 1 && ctx.config.firstNightDivine === 'randomWhite') {
            ctx.alive().forEach(function (p) {
              if (ctx.role(p).actions.indexOf('divine') < 0) return;
              var cand = ctx.alive().filter(function (q) {
                return q.id !== p.id && ctx.role(q).divine === 'human' && !ctx.role(q).diesWhenDivined;
              });
              var t = ctx.pick(cand);
              if (t) ctx.emit('divineResult', { actorId: p.id, targetId: t.id, result: 'human', oracle: true }, [p.id]);
            });
          }
        },
        resolve: function (ctx) {
          var night = { protected: {}, deaths: [] };
          E.resolveActions(ctx, night);
          var died = [];
          night.deaths.forEach(function (d) {
            if (kill(ctx, ctx.player(d.playerId), d.cause)) died.push(d.playerId);
          });
          // 発表は順番で役職がばれないよう席順に並べる
          died.sort(function (a, b) { return ctx.player(a).seat - ctx.player(b).seat; });
          ctx.state.extra.lastNightDeaths = died;
          ctx.emit('dawn', { deaths: died }, 'all');
        },
        next: function () { return 'day'; },
      },
      day: {
        id: 'day', label: function (ctx) { return dayLabel(ctx.state.day) + 'の昼'; },
        enter: function (ctx) {
          ctx.state.day += 1;
          ctx.emit('dayStart', { deaths: ctx.state.extra.lastNightDeaths || [] }, 'all');
        },
        next: function () { return 'vote'; },
      },
      vote: votePhase('vote', false),
      runoff: votePhase('runoff', true),
      end: {
        id: 'end', label: '結果',
        next: function () { return 'end'; },
      },
    };

    function votePhase(id, isRunoff) {
      return {
        id: id,
        label: function (ctx) { return dayLabel(ctx.state.day) + (isRunoff ? 'の決選投票' : 'の投票'); },
        checkWin: true,
        vote: {
          voters: function (ctx) { return ctx.alive(); },
          candidates: function (ctx) {
            if (!isRunoff) return ctx.alive();
            var ids = ctx.state.extra.runoffCandidates || [];
            return ctx.alive().filter(function (p) { return ids.indexOf(p.id) >= 0; });
          },
        },
        enter: function (ctx) { ctx.emit('voteStart', { runoff: isRunoff, candidates: ctx.state.votes.candidates }, 'all'); },
        resolve: function (ctx) {
          var v = ctx.state.votes;
          var ballots = v.voters.filter(function (id) { return id in v.ballots; }).map(function (id) { return v.ballots[id]; });
          var t = E.tally(ballots);
          var publicBallots = ctx.config.voteReveal === 'open' ? v.ballots : undefined;
          ctx.emit('voteResult', { runoff: isRunoff, counts: t.counts, ballots: publicBallots }, 'all');
          if (publicBallots === undefined) ctx.emit('voteBallots', { ballots: v.ballots }, 'gm');
          ctx.state.extra.runoffCandidates = null;
          var chosen = null;
          if (t.top.length === 1) chosen = t.top[0];
          else if (t.top.length > 1) {
            var rule = isRunoff ? ctx.config.runoffTie : ctx.config.tieRule;
            if (rule === 'runoff') { ctx.state.extra.runoffCandidates = t.top; ctx.emit('voteTie', { candidates: t.top }, 'all'); return; }
            if (rule === 'random') { chosen = ctx.pick(t.top); ctx.emit('voteTieRandom', { candidates: t.top, chosen: chosen }, 'all'); }
          }
          if (chosen) {
            kill(ctx, ctx.player(chosen), 'execution', 'gm');
            ctx.state.extra.lastExecuted = chosen;
            ctx.emit('executed', { playerId: chosen }, 'all');
          } else {
            ctx.emit('noExecution', {}, 'all');
          }
        },
        next: function (ctx) { return ctx.state.extra.runoffCandidates ? 'runoff' : 'night'; },
      };
    }

    // ---------------- 勝利条件 ----------------
    var winConditions = [
      {
        id: 'villageWins', kind: 'base', priority: 10,
        check: function (ctx) {
          return wolvesAlive(ctx).length === 0 ? { teams: ['village'], reason: '人狼がいなくなりました' } : null;
        },
      },
      {
        id: 'werewolfWins', kind: 'base', priority: 20,
        check: function (ctx) {
          return wolvesAlive(ctx).length >= humansAlive(ctx).length
            ? { teams: ['werewolf'], reason: '人狼の数が人間の数以上になりました' } : null;
        },
      },
      {
        id: 'foxSteals', kind: 'override', priority: 100,
        check: function (ctx) {
          var alive = ctx.alive().some(function (p) { return ctx.team(p) === 'fox'; });
          return alive ? { teams: ['fox'], reason: '妖狐が生き残りました' } : null;
        },
      },
    ];

    // ---------------- 準備 ----------------
    function setup(ctx, opts) {
      var n = ctx.state.players.length;
      var counts = opts.roleCounts || presetFor(n);
      var err = validateRoles(ctx.ruleset, n, counts);
      if (err) return err;
      var deck = [];
      Object.keys(counts).forEach(function (r) { for (var i = 0; i < (counts[r] || 0); i++) deck.push(r); });
      deck = ctx.shuffle(deck);
      ctx.state.players.forEach(function (p, i) {
        p.roleId = opts.assign && opts.assign[i] ? opts.assign[i] : deck[i];
      });
      ctx.state.extra.roleCounts = counts;
      ctx.emit('gameStart', { roleCounts: counts, players: ctx.state.players.map(function (p) { return p.id; }) }, 'all');
      return null;
    }

    /** viewer が知っている他人の役職 { playerId: 見せる役職ID } */
    function knowledge(ctx, me) {
      var out = {};
      ctx.players().forEach(function (p) {
        if (p.id !== me.id && sameGroup(ctx, me, p)) out[p.id] = p.roleId;
      });
      return out;
    }

    var ruleset = {
      id: 'standard',
      name: '普通の人狼',
      teams: teams,
      roles: roles,
      roleOrder: roleOrder,
      actions: actions,
      phases: phases,
      initialPhase: 'reveal',
      endPhase: 'end',
      winConditions: winConditions,
      defaultConfig: defaultConfig,
      presets: presets,
      minPlayers: minPlayers,
      maxPlayers: maxPlayers,
      presetFor: presetFor,
      validateRoles: function (n, counts) { return validateRoles(ruleset, n, counts); },
      setup: setup,
      knowledge: knowledge,
      commands: {},
      helpers: { wolvesAlive: wolvesAlive, humansAlive: humansAlive, kill: kill, sameGroup: sameGroup },
    };

    /**
     * 変則人狼を作るための拡張。
     * patch の各項目は浅く上書き（roles/actions/phases/teams/defaultConfig/commands は1段深くマージ）。
     * winConditions は配列ごと置き換えるか、関数(元の配列 => 新しい配列)で渡す。
     */
    function extend(base, patch) {
      var out = Object.assign({}, base, patch);
      ['teams', 'roles', 'actions', 'phases', 'defaultConfig', 'commands', 'presets', 'helpers'].forEach(function (k) {
        if (patch[k]) out[k] = Object.assign({}, base[k], patch[k]);
      });
      if (typeof patch.winConditions === 'function') out.winConditions = patch.winConditions(base.winConditions.slice());
      out.validateRoles = patch.validateRoles || function (n, counts) { return validateRoles(out, n, counts); };
      return out;
    }

    ruleset.extend = function (patch) { return extend(ruleset, patch); };
    return ruleset;
  });
})(typeof module !== 'undefined' && module.exports
  ? function (n, d, f) { module.exports = require('../core/module.js')(n, d, f); }
  : globalThis.WW.define);
