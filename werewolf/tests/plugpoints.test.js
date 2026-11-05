'use strict';
/*
 * 設計の検証：DESIGN.md の3つの変則人狼が「エンジンを変えずに」載るかを、最小の差し込みで確かめる。
 * ここにあるのは遊べる変則人狼ではなく、差し込み口が足りているかの試験用スケッチ。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, S, game, run, ackAll, adv, act, vote, events } = require('./helpers.js');

// ------------------------------------------------------------------
// 1. ワンナイト人狼：段階を差し替え、場札(中央の2枚)と役職交換、投票1回で決着
// ------------------------------------------------------------------
const oneNight = S.extend({
  id: 'onenight',
  roles: {
    thief: {
      id: 'thief', name: '怪盗', team: 'village', countAs: 'human', divine: 'human', medium: 'human',
      actions: ['swap'],
    },
  },
  actions: {
    divine: Object.assign({}, S.actions.divine, { available: () => true }),
    swap: {
      id: 'swap', phases: ['night'], priority: 50, changeable: false,
      targets: (ctx, me) => ctx.players().filter((p) => p.id !== me.id),
      // 夜の解決時に役職を入れ替え、怪盗は新しい役職を知る
      resolve: (ctx, inst) => {
        const me = ctx.player(inst.actorId), t = ctx.player(inst.targetId);
        const r = me.roleId; me.roleId = t.roleId; t.roleId = r;
        ctx.emit('swapResult', { newRoleId: me.roleId }, [me.id]);
      },
    },
  },
  phases: {
    night: {
      id: 'night', acceptsActions: true,
      enter: (ctx) => { ctx.state.day = 1; },
      resolve: (ctx) => E.resolveActions(ctx, { protected: {}, deaths: [] }),
      next: () => 'day',
    },
    day: { id: 'day', next: () => 'vote' },
    vote: {
      id: 'vote', checkWin: true,
      vote: { voters: (ctx) => ctx.players(), candidates: (ctx) => ctx.players() },
      resolve: (ctx) => {
        const v = ctx.state.votes;
        const t = E.tally(Object.values(v.ballots));
        ctx.state.extra.executedRoles = t.top.map((id) => ctx.player(id).roleId);
      },
      next: () => 'end',
    },
  },
  // 勝利条件を丸ごと差し替え（処刑者に人狼がいれば村、いなければ狼）
  winConditions: () => [
    { id: 'wolfExecuted', kind: 'base', priority: 1,
      check: (ctx) => (ctx.state.extra.executedRoles.includes('werewolf') ? { teams: ['village'] } : null) },
    { id: 'wolfSurvives', kind: 'base', priority: 2, check: () => ({ teams: ['werewolf'] }) },
  ],
  setup: (ctx, opts) => {
    // 人数+2 枚を配り、余りを場札にする
    const deck = ctx.shuffle(opts.deck);
    ctx.state.players.forEach((p, i) => { p.roleId = opts.assign ? opts.assign[i] : deck[i]; });
    ctx.state.extra.center = deck.slice(ctx.state.players.length);
    return null;
  },
});

test('差し込み口: ワンナイト人狼（段階の差し替え・役職交換・1回の投票で決着）', () => {
  let s = E.createGame(oneNight, {
    players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    deck: ['werewolf', 'seer', 'thief', 'villager', 'villager'],
    assign: { 0: 'werewolf', 1: 'seer', 2: 'thief' },
    seed: 1,
  });
  assert.equal(s.extra.center.length, 2);
  s = ackAll(s, oneNight);
  s = run(s, [act('p2', 'divine', 'p1'), act('p3', 'swap', 'p1'), adv, adv], oneNight);
  // 怪盗(p3)は人狼になり、p1 は怪盗に
  assert.equal(s.players[2].roleId, 'werewolf');
  assert.equal(events(s, 'swapResult')[0].data.newRoleId, 'werewolf');
  // 占いは交換前の役職を見ている（解決順: 占い20 → 交換50）
  assert.equal(events(s, 'divineResult')[0].data.result, 'werewolf');
  s = run(s, [vote('p1', 'p3'), vote('p2', 'p3'), vote('p3', 'p1'), adv], oneNight);
  assert.equal(s.phase, 'end');
  assert.deepEqual(s.result.teams, ['village']);
  assert.deepEqual(s.result.winners.sort(), ['p1', 'p2']); // 今の陣営で判定（元怪盗の p1 は村側）
});

// ------------------------------------------------------------------
// 2. 第二の目的人狼：各自に秘密の個人目的を配り、陣営の勝敗とは別に個人勝利を足す
// ------------------------------------------------------------------
const objectives = {
  survive: { name: '最後まで生き残る', check: (ctx, p) => p.alive },
  outliveSeat1: { name: '1番席の人より長く生きる', check: (ctx, p) => p.alive && !ctx.state.players[0].alive },
};
const secondGoal = S.extend({
  id: 'second-goal',
  setup: (ctx, opts) => {
    const err = S.setup(ctx, opts);
    if (err) return err;
    ctx.state.players.forEach((p) => {
      p.memory.objective = (opts.objectives && opts.objectives[p.id]) || ctx.pick(Object.keys(objectives));
      ctx.emit('objectiveAssigned', { objective: p.memory.objective }, [p.id]);
    });
    return null;
  },
  winConditions: (base) => base.concat([{
    id: 'secondObjective', kind: 'individual', priority: 200,
    check: (ctx) => ctx.state.players.filter((p) => objectives[p.memory.objective].check(ctx, p)).map((p) => p.id),
  }]),
});

test('差し込み口: 第二の目的人狼（個人目的の配布と、陣営勝利への個人勝利の追加）', () => {
  let s = E.createGame(secondGoal, {
    players: ['A', 'B', 'C', 'D', 'E'].map((name) => ({ name })),
    roleCounts: { werewolf: 1, seer: 1, villager: 2, madman: 1 },
    assign: { 0: 'werewolf', 1: 'seer', 2: 'villager', 3: 'villager', 4: 'madman' },
    objectives: { p1: 'survive', p2: 'survive', p3: 'survive', p4: 'survive', p5: 'outliveSeat1' },
    seed: 3,
  });
  // 目的は本人にだけ見える
  assert.equal(E.view(s, secondGoal, 'p5').log.filter((e) => e.type === 'objectiveAssigned').length, 1);
  assert.equal(E.view(s, secondGoal, 'p4').log.filter((e) => e.type === 'objectiveAssigned').length, 1);
  assert.equal(E.view(s, secondGoal, 'public').log.filter((e) => e.type === 'objectiveAssigned').length, 0);
  s = ackAll(s, secondGoal);
  s = run(s, [act('p2', 'divine', 'p1'), adv, adv], secondGoal);
  s = run(s, s.votes.voters.map((v) => vote(v, v === 'p1' ? 'p2' : 'p1')).concat([adv]), secondGoal);
  assert.deepEqual(s.result.teams, ['village']);
  // 狂人(p5)は陣営では負けだが、個人目的「1番席より長く生きる」を達成
  assert.ok(s.result.winners.includes('p5'));
  assert.ok(!s.result.winners.includes('p1'));
});

// ------------------------------------------------------------------
// 3. 能力をカードで消費する制：能力を使うたびにカードを1枚消費し、無くなると使えない
// ------------------------------------------------------------------
function withCost(action) {
  return Object.assign({}, action, {
    available: (ctx, me) => (me.counters.cards || 0) > 0 && (!action.available || action.available(ctx, me)),
    resolve: (ctx, inst, scratch) => {
      inst.actorIds.forEach((id) => { ctx.player(id).counters.cards -= 1; });
      if (action.resolve) action.resolve(ctx, inst, scratch);
    },
  });
}
const cardRule = S.extend({
  id: 'ability-cards',
  defaultConfig: { startingCards: 1 },
  actions: { divine: withCost(S.actions.divine), guard: withCost(S.actions.guard) },
  setup: (ctx, opts) => {
    const err = S.setup(ctx, opts);
    ctx.state.players.forEach((p) => { p.counters.cards = ctx.config.startingCards; });
    return err;
  },
  // 追加の命令：カードを他人に渡す（エンジンの dispatch に新しい命令を差し込む例）
  commands: {
    giveCard: (ctx, cmd) => {
      const from = ctx.player(cmd.playerId), to = ctx.player(cmd.targetId);
      if (!from || !to || (from.counters.cards || 0) < 1) return 'カードがありません';
      from.counters.cards -= 1; to.counters.cards += 1;
      ctx.emit('cardGiven', { from: from.id, to: to.id }, [from.id, to.id]);
      return null;
    },
  },
});

test('差し込み口: 能力カード消費制（回数制限と追加命令）', () => {
  const roles = ['werewolf', 'seer', 'knight', 'villager', 'villager', 'villager', 'werewolf'];
  let s = ackAll(game(roles, {}, cardRule), cardRule);
  s = run(s, [act('p2', 'divine', 'p1'), adv, adv], cardRule);
  assert.equal(s.players[1].counters.cards, 0);
  s = run(s, s.votes.voters.map((v) => vote(v, v === 'p4' ? 'p5' : 'p4')).concat([adv]), cardRule);
  // 2日目の夜：カードが無いので占えない
  assert.equal(E.availableActions(E.makeCtx(s, cardRule), 'p2').length, 0);
  // 村人がカードを渡すとまた占える
  s = run(s, [{ type: 'giveCard', playerId: 'p5', targetId: 'p2' }], cardRule);
  assert.equal(E.availableActions(E.makeCtx(s, cardRule), 'p2')[0].actionId, 'divine');
  // カードの枚数は本人にしか見えない
  assert.equal(E.view(s, cardRule, 'p3').players[1].counters, undefined);
  assert.equal(E.view(s, cardRule, 'p2').me.counters.cards, 1);
});
