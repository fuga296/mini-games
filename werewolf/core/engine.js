/*
 * 人狼エンジン（汎用部）。画面にもブラウザにも依存しない純粋なロジック。
 *
 * ・状態(state)はただの JSON。保存・送信・再現ができる。
 * ・ルールの中身（役職・行動・段階・勝利条件）はすべて「ルールセット」側のデータと関数。
 *   エンジンはそれを順番どおりに呼ぶだけ。変則人狼はルールセットを差し替え・拡張して作る。
 * ・すべての操作は dispatch(state, ruleset, command) で行い、新しい state を返す（元の state は変えない）。
 * ・誰に何が見えるかは view(state, ruleset, viewerId) が決める。画面はこれだけを見る。
 *
 * 詳しくは DESIGN.md。
 */
(function (define) {
  define('engine', ['rng'], function (RNG) {
    'use strict';

    var VIEWER_GM = 'gm';         // 司会（すべて見える）
    var VIEWER_PUBLIC = 'public'; // 全員に見せてよい情報だけ

    function clone(x) { return JSON.parse(JSON.stringify(x)); }

    // ------------------------------------------------------------------
    // 文脈(ctx)：ルールセットの関数に渡す道具一式。state を直接書き換えてよい（dispatch 内で複製済み）。
    // ------------------------------------------------------------------
    function makeCtx(state, ruleset) {
      var ctx = {
        state: state,
        ruleset: ruleset,
        config: state.config,
        random: function () {
          var r = RNG.next(state.rng);
          state.rng = r.state;
          return r.value;
        },
        pick: function (arr) { return arr.length ? arr[Math.floor(ctx.random() * arr.length)] : undefined; },
        shuffle: function (arr) {
          var a = arr.slice();
          for (var i = a.length - 1; i > 0; i--) {
            var j = Math.floor(ctx.random() * (i + 1));
            var t = a[i]; a[i] = a[j]; a[j] = t;
          }
          return a;
        },
        players: function () { return state.players; },
        alive: function () { return state.players.filter(function (p) { return p.alive; }); },
        player: function (id) {
          for (var i = 0; i < state.players.length; i++) if (state.players[i].id === id) return state.players[i];
          return null;
        },
        role: function (p) {
          if (typeof p === 'string') p = ctx.player(p);
          return p ? ruleset.roles[p.roleId] : null;
        },
        /** 陣営。役職の陣営を、個人ごとの上書き(p.team)が優先する（寝返り系の変則用）。 */
        team: function (p) {
          if (typeof p === 'string') p = ctx.player(p);
          return p ? (p.team || (ruleset.roles[p.roleId] || {}).team) : null;
        },
        /**
         * 記録を残す。visibleTo:
         *   'all'           全員に公開
         *   'gm'            司会のみ
         *   ['p1','p2',...] その人たちと司会のみ
         */
        emit: function (type, data, visibleTo) {
          state.seq += 1;
          var ev = {
            id: state.seq,
            type: type,
            day: state.day,
            phase: state.phase,
            data: data || {},
            visibleTo: visibleTo == null ? 'all' : visibleTo,
          };
          state.log.push(ev);
          return ev;
        },
        phaseDef: function () { return ruleset.phases[state.phase]; },
      };
      return ctx;
    }

    // ------------------------------------------------------------------
    // ゲーム作成
    // ------------------------------------------------------------------
    /**
     * @param ruleset ルールセット
     * @param opts { players:[{name}], config?, seed?, roleCounts?:{roleId:n}, assign?:{playerIndex:roleId} }
     */
    function createGame(ruleset, opts) {
      opts = opts || {};
      var config = Object.assign({}, ruleset.defaultConfig || {}, opts.config || {});
      var state = {
        format: 'werewolf-state',
        version: 1,
        rulesetId: ruleset.id,
        config: config,
        rng: RNG.seedFrom(opts.seed),
        day: 0,
        phase: null,
        players: (opts.players || []).map(function (p, i) {
          return {
            id: 'p' + (i + 1),
            name: p.name || ('プレイヤー' + (i + 1)),
            seat: i,
            roleId: null,
            team: null,     // 個人の陣営上書き（通常は null）
            alive: true,
            counters: {},   // 回数・カード枚数など（変則用の汎用カウンタ）
            memory: {},     // 役職が覚えておく値（前夜の護衛先など）
          };
        }),
        log: [],
        seq: 0,
        actions: {},      // 今の段階で出された行動 { playerId: { actionId: targetId } }
        acks: {},         // 確認済み { playerId: true }
        votes: null,      // { candidates:[ids], voters:[ids], ballots:{voterId:targetId} }
        result: null,     // 勝敗 { teams:[], players:[], reason, winners:[ids] }
        extra: {},        // ルールセットが自由に使う場所
      };
      var ctx = makeCtx(state, ruleset);
      var err = ruleset.setup(ctx, opts);
      if (err) throw new Error(err);
      enterPhase(ctx, ruleset.initialPhase);
      return state;
    }

    function enterPhase(ctx, phaseId) {
      var def = ctx.ruleset.phases[phaseId];
      if (!def) throw new Error('未定義の段階: ' + phaseId);
      ctx.state.phase = phaseId;
      ctx.state.actions = {};
      ctx.state.acks = {};
      ctx.state.votes = null;
      if (def.vote) {
        ctx.state.votes = {
          candidates: def.vote.candidates(ctx).map(function (p) { return p.id; }),
          voters: def.vote.voters(ctx).map(function (p) { return p.id; }),
          ballots: {},
        };
      }
      if (def.enter) def.enter(ctx);
    }

    // ------------------------------------------------------------------
    // 行動
    // ------------------------------------------------------------------
    /** その人が今の段階で取れる行動 [{ actionId, targets:[ids], required, chosen }] */
    function availableActions(ctx, playerId) {
      var p = ctx.player(playerId);
      var def = ctx.phaseDef();
      if (!p || !def || !def.acceptsActions) return [];
      if (!p.alive && !def.deadCanAct) return [];
      var role = ctx.role(p);
      var ids = (role && role.actions) || [];
      var out = [];
      ids.forEach(function (aid) {
        var a = ctx.ruleset.actions[aid];
        if (!a) return;
        if (a.phases && a.phases.indexOf(ctx.state.phase) < 0) return;
        if (a.available && !a.available(ctx, p)) return;
        var targets = a.targets ? a.targets(ctx, p).map(function (t) { return t.id; }) : [];
        var chosen = (ctx.state.actions[p.id] || {})[aid];
        out.push({
          actionId: aid,
          targets: targets,
          required: a.required !== false,
          chosen: chosen === undefined ? null : chosen,
        });
      });
      return out;
    }

    /** まだ入力していない人の一覧（司会向け。公開の画面には出さないこと） */
    function pending(state, ruleset) {
      var ctx = makeCtx(state, ruleset);
      var def = ctx.phaseDef();
      var out = [];
      if (!def) return out;
      if (def.acks) {
        def.acks(ctx).forEach(function (p) {
          if (!state.acks[p.id]) out.push({ playerId: p.id, kind: 'ack' });
        });
      }
      if (def.acceptsActions) {
        state.players.forEach(function (p) {
          availableActions(ctx, p.id).forEach(function (a) {
            if (a.required && a.chosen === null) out.push({ playerId: p.id, kind: 'action', actionId: a.actionId });
          });
        });
      }
      if (state.votes) {
        state.votes.voters.forEach(function (id) {
          if (!(id in state.votes.ballots)) out.push({ playerId: id, kind: 'vote' });
        });
      }
      return out;
    }

    /**
     * 夜などの行動をまとめて解決する（ルールセットの段階 resolve から呼ぶ）。
     * - aggregate を持つ行動（人狼の襲撃など）は、出された対象を1つにまとめて1回だけ解決する。
     * - priority の小さい順に resolve(ctx, inst, scratch) を呼ぶ。同じ priority は席順。
     * - scratch は解決中の一時メモ（護衛済み・死亡予定など）。中身はルールセットが決める。
     */
    function resolveActions(ctx, scratch) {
      var state = ctx.state;
      var ruleset = ctx.ruleset;
      var instances = [];
      var groups = {};
      state.players.forEach(function (p) {
        var acts = state.actions[p.id] || {};
        Object.keys(acts).forEach(function (aid) {
          var def = ruleset.actions[aid];
          if (!def) return;
          var inst = { actionId: aid, actorId: p.id, actorIds: [p.id], targetId: acts[aid], seat: p.seat, def: def };
          if (def.aggregate) {
            var g = groups[aid];
            if (!g) {
              g = groups[aid] = { actionId: aid, actorId: p.id, actorIds: [], choices: [], seat: p.seat, def: def };
              instances.push(g);
            }
            g.actorIds.push(p.id);
            g.choices.push(acts[aid]);
          } else {
            instances.push(inst);
          }
        });
      });
      instances.forEach(function (inst) {
        if (inst.def.aggregate) inst.targetId = aggregate(ctx, inst.def.aggregate, inst.choices);
      });
      instances.sort(function (a, b) {
        return (a.def.priority || 0) - (b.def.priority || 0) || a.seat - b.seat;
      });
      instances.forEach(function (inst) {
        if (inst.targetId === null || inst.targetId === undefined) {
          if (!inst.def.allowNoTarget) return;
        }
        if (inst.def.resolve) inst.def.resolve(ctx, inst, scratch);
      });
      return instances;
    }

    /** 複数人の選択を1つにまとめる。'majority' = 最多（同数は config.aggregateTie: 'random'|'none'） */
    function aggregate(ctx, kind, choices) {
      if (typeof kind === 'function') return kind(ctx, choices);
      var valid = choices.filter(function (c) { return c !== null && c !== undefined; });
      if (!valid.length) return null;
      if (kind === 'first') return valid[0];
      var t = tally(valid);
      if (t.top.length === 1) return t.top[0];
      return ctx.config.aggregateTie === 'none' ? null : ctx.pick(t.top);
    }

    /** 集計。{ counts:{id:n}, top:[最多の id], max } */
    function tally(values) {
      var counts = {};
      var order = [];
      values.forEach(function (v) {
        if (v === null || v === undefined) return;
        if (!(v in counts)) { counts[v] = 0; order.push(v); }
        counts[v] += 1;
      });
      var max = 0;
      order.forEach(function (k) { if (counts[k] > max) max = counts[k]; });
      return { counts: counts, top: order.filter(function (k) { return counts[k] === max && max > 0; }), max: max };
    }

    // ------------------------------------------------------------------
    // 勝利判定
    // ------------------------------------------------------------------
    /**
     * ruleset.winConditions を priority 順に評価する。
     *  kind 'base'       : 最初に成立したものが暫定結果（成立しなければ続行）
     *  kind 'override'   : 暫定結果があるとき、それを上書きできる（妖狐など）
     *  kind 'individual' : 暫定結果があるとき、個人の勝者を追加できる（第二の目的など）
     * 戻り値 { teams:[], players:[], reason, winners:[ids] } または null
     */
    function checkWin(ctx) {
      var list = (ctx.ruleset.winConditions || []).slice().sort(function (a, b) {
        return (a.priority || 0) - (b.priority || 0);
      });
      var result = null;
      list.forEach(function (wc) {
        var kind = wc.kind || 'base';
        if (kind === 'base' && !result) {
          var r = wc.check(ctx);
          if (r) result = { teams: r.teams || [], players: r.players || [], reason: r.reason || wc.id, by: wc.id };
        }
      });
      if (!result) return null;
      list.forEach(function (wc) {
        if (wc.kind === 'override') {
          var r = wc.check(ctx, result);
          if (r) result = { teams: r.teams || [], players: r.players || [], reason: r.reason || wc.id, by: wc.id };
        }
      });
      list.forEach(function (wc) {
        if (wc.kind === 'individual') {
          var add = wc.check(ctx, result) || [];
          add.forEach(function (id) { if (result.players.indexOf(id) < 0) result.players.push(id); });
        }
      });
      result.winners = ctx.state.players
        .filter(function (p) { return result.teams.indexOf(ctx.team(p)) >= 0 || result.players.indexOf(p.id) >= 0; })
        .map(function (p) { return p.id; });
      return result;
    }

    // ------------------------------------------------------------------
    // 命令の受付
    // ------------------------------------------------------------------
    /**
     * command:
     *   { type:'ack',     playerId }
     *   { type:'act',     playerId, actionId, targetId }
     *   { type:'vote',    playerId, targetId }
     *   { type:'advance', force? }       段階を進める（未入力があれば force が必要）
     *   その他は ruleset.commands[type](ctx, command) に渡す（変則用の差し込み口）
     * 戻り値 { ok:true, state, events:[今回増えた記録] } / { ok:false, error, state(元のまま) }
     */
    function dispatch(state0, ruleset, command) {
      if (!command || !command.type) return fail(state0, '命令の形式が不正です');
      if (state0.result && command.type !== 'noop') return fail(state0, 'ゲームは終了しています');
      var state = clone(state0);
      var ctx = makeCtx(state, ruleset);
      var def = ctx.phaseDef();
      var before = state.seq;
      var err = null;
      switch (command.type) {
        case 'ack': {
          var list = def && def.acks ? def.acks(ctx).map(function (p) { return p.id; }) : [];
          if (list.indexOf(command.playerId) < 0) { err = 'この段階では確認は不要です'; break; }
          state.acks[command.playerId] = true;
          break;
        }
        case 'act': {
          var avail = availableActions(ctx, command.playerId);
          var a = null;
          avail.forEach(function (x) { if (x.actionId === command.actionId) a = x; });
          if (!a) { err = 'その行動は今できません'; break; }
          var adef = ruleset.actions[command.actionId];
          var target = command.targetId === undefined ? null : command.targetId;
          if (target === null) {
            if (!adef.allowNoTarget) { err = '対象を選んでください'; break; }
          } else if (a.targets.indexOf(target) < 0) { err = 'その対象は選べません'; break; }
          if (a.chosen !== null && adef.changeable === false) { err = 'この行動は変更できません'; break; }
          state.actions[command.playerId] = state.actions[command.playerId] || {};
          state.actions[command.playerId][command.actionId] = target;
          if (adef.instant) adef.instant(ctx, ctx.player(command.playerId), target);
          break;
        }
        case 'vote': {
          var v = state.votes;
          if (!v) { err = '今は投票の時間ではありません'; break; }
          if (v.voters.indexOf(command.playerId) < 0) { err = '投票できません'; break; }
          var options = voteOptions(ctx, command.playerId);
          if (options.indexOf(command.targetId) < 0) { err = 'その人には投票できません'; break; }
          v.ballots[command.playerId] = command.targetId;
          break;
        }
        case 'advance': {
          var pend = pending(state, ruleset);
          if (pend.length && !command.force) { err = 'まだ入力していない人がいます'; break; }
          if (def.resolve) def.resolve(ctx);
          if (def.checkWin) {
            var res = checkWin(ctx);
            if (res) {
              state.result = res;
              ctx.emit('gameEnd', res, 'all');
              enterPhase(ctx, ruleset.endPhase || 'end');
              break;
            }
          }
          var nextId = def.next(ctx);
          enterPhase(ctx, nextId);
          break;
        }
        default: {
          var h = ruleset.commands && ruleset.commands[command.type];
          if (!h) { err = '不明な命令: ' + command.type; break; }
          err = h(ctx, command) || null;
        }
      }
      if (err) return fail(state0, err);
      return { ok: true, state: state, events: state.log.filter(function (ev) { return ev.id > before; }) };
    }
    function fail(state, error) { return { ok: false, error: error, state: state, events: [] }; }

    /** その投票者が選べる候補 */
    function voteOptions(ctx, voterId) {
      var v = ctx.state.votes;
      if (!v) return [];
      return v.candidates.filter(function (id) {
        return id !== voterId || ctx.config.allowSelfVote;
      });
    }

    // ------------------------------------------------------------------
    // 見え方
    // ------------------------------------------------------------------
    function canSee(ev, viewerId) {
      if (viewerId === VIEWER_GM) return true;
      if (ev.visibleTo === 'all') return true;
      if (ev.visibleTo === 'gm') return false;
      return Array.isArray(ev.visibleTo) && ev.visibleTo.indexOf(viewerId) >= 0;
    }

    /**
     * viewerId に見せてよい情報だけを返す。
     * viewerId: プレイヤーID / 'gm' / 'public'
     * 各自の端末で遊ぶ形にするときは、サーバー側でこれを作って各端末に送る。
     */
    function view(state, ruleset, viewerId) {
      var ctx = makeCtx(clone(state), ruleset);
      var s = ctx.state;
      var isGM = viewerId === VIEWER_GM;
      var me = isGM || viewerId === VIEWER_PUBLIC ? null : ctx.player(viewerId);
      var ended = !!s.result;
      var known = {};
      if (me) known = (ruleset.knowledge ? ruleset.knowledge(ctx, me) : {}) || {};
      var phaseDef = ctx.phaseDef() || {};
      var players = s.players.map(function (p) {
        var showRole = isGM || ended || (me && me.id === p.id) ||
          (!p.alive && s.config.revealRoleOnDeath) || known[p.id] !== undefined;
        var roleId = showRole ? (known[p.id] !== undefined && !(isGM || ended || (me && me.id === p.id)) ? known[p.id] : p.roleId) : null;
        return {
          id: p.id,
          name: p.name,
          seat: p.seat,
          alive: p.alive,
          roleId: roleId,
          team: isGM || ended || (me && me.id === p.id) ? ctx.team(p) : null,
          counters: isGM || (me && me.id === p.id) ? p.counters : undefined,
        };
      });
      var out = {
        viewer: viewerId,
        day: s.day,
        phase: s.phase,
        phaseLabel: phaseDef.label ? (typeof phaseDef.label === 'function' ? phaseDef.label(ctx) : phaseDef.label) : s.phase,
        players: players,
        log: s.log.filter(function (ev) { return canSee(ev, viewerId); }),
        result: s.result,
        config: s.config,
        me: null,
        vote: null,
      };
      if (me) {
        var actions = availableActions(ctx, me.id);
        // 同じ行動を一緒に行う仲間（人狼どうしなど）の選択を見せる
        actions.forEach(function (a) {
          var adef = ruleset.actions[a.actionId];
          if (adef.aggregate && adef.shareChoices) {
            a.allies = s.players.filter(function (p) {
              return p.id !== me.id && known[p.id] !== undefined && s.actions[p.id] && a.actionId in s.actions[p.id];
            }).map(function (p) { return { playerId: p.id, targetId: s.actions[p.id][a.actionId] }; });
          }
        });
        out.me = {
          id: me.id,
          name: me.name,
          alive: me.alive,
          roleId: me.roleId,
          team: ctx.team(me),
          counters: me.counters,
          known: known,
          actions: actions,
          acked: !!s.acks[me.id],
          needsAck: !!(phaseDef.acks && phaseDef.acks(ctx).some(function (p) { return p.id === me.id; })),
        };
      }
      if (s.votes) {
        out.vote = {
          candidates: s.votes.candidates,
          voters: s.votes.voters,
          // 誰が何票かは集計後の記録で公開する。投票中は本人の票と、司会には全票が見える
          ballots: isGM ? s.votes.ballots : undefined,
          myBallot: me && me.id in s.votes.ballots ? s.votes.ballots[me.id] : null,
          myOptions: me ? voteOptions(ctx, me.id) : [],
          optionsFor: isGM ? s.votes.voters.reduce(function (m, id) { m[id] = voteOptions(ctx, id); return m; }, {}) : undefined,
        };
      }
      if (isGM) {
        out.pending = pending(state, ruleset);
        out.actions = s.actions;
        out.gmOptions = {};
        s.players.forEach(function (p) { out.gmOptions[p.id] = availableActions(ctx, p.id); });
      }
      return out;
    }

    return {
      VIEWER_GM: VIEWER_GM,
      VIEWER_PUBLIC: VIEWER_PUBLIC,
      createGame: createGame,
      dispatch: dispatch,
      view: view,
      pending: pending,
      checkWin: checkWin,
      tally: tally,
      resolveActions: resolveActions,
      availableActions: availableActions,
      makeCtx: makeCtx,
      enterPhase: enterPhase,
      clone: clone,
    };
  });
})(typeof module !== 'undefined' && module.exports
  ? function (n, d, f) { module.exports = require('./module.js')(n, d, f); }
  : globalThis.WW.define);
