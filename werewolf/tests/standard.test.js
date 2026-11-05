'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, S, game, run, ackAll, adv, act, vote, alive, events } = require('./helpers.js');

// 席: p1 人狼, p2 占い師, p3 騎士, p4 霊媒師, p5 村人, p6 村人, p7 人狼
const SEVEN = ['werewolf', 'seer', 'knight', 'medium', 'villager', 'villager', 'werewolf'];

/** 初日夜（襲撃なし）→ 昼 → 投票で target を処刑 → 2日目夜 の手前まで進める */
function toSecondNight(state, executeId, votersFn) {
  state = run(state, [act('p2', 'divine', 'p1'), adv, adv]); // 初日夜 → 昼 → 投票
  const voters = state.votes.voters;
  state = run(state, voters.map((v) => vote(v, v === executeId ? voters.find((x) => x !== v) : executeId)).concat([adv]));
  return state;
}

test('配役: プリセットは人数ぴったりで、妥当性チェックを通る', () => {
  for (let n = S.minPlayers; n <= 15; n++) {
    const c = S.presetFor(n);
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    assert.equal(total, n);
    assert.equal(S.validateRoles(n, c), null, n + '人');
  }
  assert.match(S.validateRoles(4, { werewolf: 2, villager: 2 }), /人狼が人間以上/);
  assert.match(S.validateRoles(5, { werewolf: 1, villager: 2 }), /合いません/);
});

test('配役: 種が同じなら同じ配役（再現できる）', () => {
  const mk = (seed) => E.createGame(S, { players: Array.from({ length: 8 }, (_, i) => ({ name: 'x' + i })), seed })
    .players.map((p) => p.roleId).join();
  assert.equal(mk(7), mk(7));
  assert.notEqual(mk(1) + mk(2) + mk(3), mk(1) + mk(1) + mk(1));
});

test('役職の確認: 全員が確認するまで進めない', () => {
  let s = game(SEVEN);
  assert.equal(s.phase, 'reveal');
  const r = E.dispatch(s, S, adv);
  assert.equal(r.ok, false);
  s = ackAll(s);
  assert.equal(s.phase, 'night');
  assert.equal(s.day, 1);
});

test('初日夜: 既定では襲撃も護衛もなく、占いだけできる', () => {
  let s = ackAll(game(SEVEN));
  const ctx = E.makeCtx(s, S);
  assert.deepEqual(E.availableActions(ctx, 'p1'), []);
  assert.deepEqual(E.availableActions(ctx, 'p3'), []);
  assert.equal(E.availableActions(ctx, 'p2')[0].actionId, 'divine');
  s = run(s, [act('p2', 'divine', 'p7')]);
  const res = events(s, 'divineResult');
  assert.equal(res.length, 1);
  assert.equal(res[0].data.result, 'werewolf');
  assert.deepEqual(res[0].visibleTo, ['p2']);
  s = run(s, [adv]);
  assert.equal(s.phase, 'day');
  assert.equal(s.day, 2);
  assert.deepEqual(events(s, 'dawn')[0].data.deaths, []);
});

test('占いは一度決めたら変えられない', () => {
  let s = ackAll(game(SEVEN));
  s = run(s, [act('p2', 'divine', 'p5')]);
  assert.equal(E.dispatch(s, S, act('p2', 'divine', 'p1')).ok, false);
});

test('夜の解決順: 護衛 → 占い → 襲撃。護衛された人は襲撃で死なない', () => {
  let s = ackAll(game(SEVEN, { firstNightAttack: true }));
  s = run(s, [act('p2', 'divine', 'p5'), act('p3', 'guard', 'p5'), act('p1', 'attack', 'p5'), act('p7', 'attack', 'p5'), adv]);
  assert.deepEqual(alive(s).length, 7);
  const order = s.log.filter((e) => ['guarded', 'attackTarget', 'attackBlocked'].includes(e.type)).map((e) => e.type);
  assert.deepEqual(order, ['guarded', 'attackTarget', 'attackBlocked']);
  // 平和な朝は公開、守られた理由は司会だけ
  assert.deepEqual(events(s, 'dawn')[0].data.deaths, []);
  assert.equal(events(s, 'attackBlocked')[0].visibleTo, 'gm');
});

test('襲撃: 守られていなければ死ぬ。人狼の票が割れたら設定どおり', () => {
  let s = ackAll(game(SEVEN, { firstNightAttack: true }));
  s = run(s, [act('p2', 'divine', 'p5'), act('p3', 'guard', 'p6'), act('p1', 'attack', 'p5'), act('p7', 'attack', 'p5'), adv]);
  assert.deepEqual(events(s, 'dawn')[0].data.deaths, ['p5']);

  let t = ackAll(game(SEVEN, { firstNightAttack: true, aggregateTie: 'none' }));
  t = run(t, [act('p2', 'divine', 'p5'), act('p3', 'guard', 'p6'), act('p1', 'attack', 'p4'), act('p7', 'attack', 'p5'), adv]);
  assert.deepEqual(events(t, 'dawn')[0].data.deaths, []);

  let u = ackAll(game(SEVEN, { firstNightAttack: true, aggregateTie: 'random' }));
  u = run(u, [act('p2', 'divine', 'p5'), act('p3', 'guard', 'p6'), act('p1', 'attack', 'p4'), act('p7', 'attack', 'p5'), adv]);
  const d = events(u, 'dawn')[0].data.deaths;
  assert.equal(d.length, 1);
  assert.ok(['p4', 'p5'].includes(d[0]));
});

test('人狼は仲間を襲撃先に選べず、仲間の選択が見える', () => {
  let s = ackAll(game(SEVEN, { firstNightAttack: true }));
  const ctx = E.makeCtx(s, S);
  assert.ok(!E.availableActions(ctx, 'p1')[0].targets.includes('p7'));
  s = run(s, [act('p1', 'attack', 'p5')]);
  const v = E.view(s, S, 'p7');
  assert.deepEqual(v.me.actions[0].allies, [{ playerId: 'p1', targetId: 'p5' }]);
  assert.equal(v.players.find((p) => p.id === 'p1').roleId, 'werewolf');
  // 村人からは人狼の選択も役職も見えない
  const vv = E.view(s, S, 'p5');
  assert.equal(vv.players.find((p) => p.id === 'p1').roleId, null);
  assert.equal(vv.me.actions.length, 0);
});

test('騎士: 同じ人を連続で守れない（既定）。設定で変えられる', () => {
  let s = ackAll(game(SEVEN, { firstNightAttack: true }));
  s = run(s, [act('p2', 'divine', 'p5'), act('p3', 'guard', 'p5'), act('p1', 'attack', 'p6'), act('p7', 'attack', 'p6'), adv, adv]);
  s = run(s, s.votes.voters.map((v) => vote(v, v === 'p4' ? 'p5' : 'p4')).concat([adv]));
  assert.equal(s.phase, 'night');
  let opts = E.availableActions(E.makeCtx(s, S), 'p3')[0].targets;
  assert.ok(!opts.includes('p5'));
  assert.ok(!opts.includes('p3'));

  let t = ackAll(game(SEVEN, { firstNightAttack: true, consecutiveGuard: true, selfGuard: true }));
  t = run(t, [act('p2', 'divine', 'p5'), act('p3', 'guard', 'p5'), act('p1', 'attack', 'p6'), act('p7', 'attack', 'p6'), adv, adv]);
  t = run(t, t.votes.voters.map((v) => vote(v, v === 'p4' ? 'p5' : 'p4')).concat([adv]));
  opts = E.availableActions(E.makeCtx(t, S), 'p3')[0].targets;
  assert.ok(opts.includes('p5') && opts.includes('p3'));
});

test('投票: 最多票の人が処刑され、霊媒師は次の夜に結果を知る', () => {
  let s = ackAll(game(SEVEN));
  s = toSecondNight(s, 'p7');
  assert.equal(s.players.find((p) => p.id === 'p7').alive, false);
  assert.equal(events(s, 'executed')[0].data.playerId, 'p7');
  assert.equal(s.phase, 'night');
  const m = events(s, 'mediumResult');
  assert.equal(m.length, 1);
  assert.equal(m[0].data.result, 'werewolf');
  assert.deepEqual(m[0].visibleTo, ['p4']);
  // 他の人には見えない
  assert.equal(E.view(s, S, 'p5').log.filter((e) => e.type === 'mediumResult').length, 0);
  assert.equal(E.view(s, S, 'gm').log.filter((e) => e.type === 'mediumResult').length, 1);
});

test('投票: 自分には投票できない（既定）', () => {
  let s = ackAll(game(SEVEN));
  s = run(s, [act('p2', 'divine', 'p1'), adv, adv]);
  assert.equal(E.dispatch(s, S, vote('p1', 'p1')).ok, false);
  assert.equal(E.dispatch(s, S, vote('p1', 'p2')).ok, true);
});

test('投票: 同数なら決選投票、それも同数なら設定どおり（ランダム / 処刑なし）', () => {
  const setupTie = (cfg) => {
    let s = ackAll(game(SEVEN, cfg));
    s = run(s, [act('p2', 'divine', 'p1'), adv, adv]);
    // p1: 3票, p2: 3票, p3: 1票
    const b = { p1: 'p2', p2: 'p1', p3: 'p1', p4: 'p2', p5: 'p1', p6: 'p2', p7: 'p3' };
    return run(s, Object.entries(b).map(([v, t]) => vote(v, t)).concat([adv]));
  };
  let s = setupTie({});
  assert.equal(s.phase, 'runoff');
  assert.deepEqual(s.votes.candidates, ['p1', 'p2']); // 席順
  assert.ok(E.dispatch(s, S, vote('p3', 'p3')).ok === false);
  const b2 = { p1: 'p2', p2: 'p1', p3: 'p1', p4: 'p2', p5: 'p1', p6: 'p2' };
  const t = run(s, Object.entries(b2).map(([v, x]) => vote(v, x)).concat([vote('p7', 'p1'), adv]));
  assert.equal(events(t, 'executed')[0].data.playerId, 'p1');

  // 決選投票も同数 → 処刑なし（p7 は棄権。未投票は司会/親機が force で進める）
  let m = setupTie({ runoffTie: 'none' });
  m = run(m, Object.entries(b2).map(([v, x]) => vote(v, x)));
  assert.equal(E.dispatch(m, S, adv).ok, false, '未投票があると force なしでは進めない');
  m = run(m, [{ type: 'advance', force: true }]);
  assert.equal(events(m, 'noExecution').length, 1);
  assert.equal(m.phase, 'night');

  // 決選投票を使わない設定（同数なら処刑なし）
  const z = setupTie({ tieRule: 'none' });
  assert.equal(z.phase, 'night');
  assert.equal(events(z, 'noExecution').length, 1);
});

test('勝利: 人狼が全滅すると村人陣営の勝ち（狂人は負け）', () => {
  let s = ackAll(game(['werewolf', 'seer', 'villager', 'villager', 'madman']));
  s = run(s, [act('p2', 'divine', 'p1'), adv, adv]);
  s = run(s, s.votes.voters.map((v) => vote(v, v === 'p1' ? 'p2' : 'p1')).concat([adv]));
  assert.equal(s.phase, 'end');
  assert.deepEqual(s.result.teams, ['village']);
  assert.deepEqual(s.result.winners.sort(), ['p2', 'p3', 'p4']);
  assert.equal(E.dispatch(s, S, adv).ok, false);
});

test('勝利: 人狼の数が人間以上になると人狼陣営の勝ち（狂人も勝ち）', () => {
  // 人狼1 狂人1 村人2 占1。処刑で村人が1人減り、夜の襲撃で人狼1 vs 人間2(狂人含む)→ さらに減ると勝ち
  let s = ackAll(game(['werewolf', 'seer', 'villager', 'villager', 'madman'], { firstNightAttack: true }));
  s = run(s, [act('p2', 'divine', 'p3'), act('p1', 'attack', 'p2'), adv]); // 占い師死亡: 人狼1 vs 人間3
  assert.equal(s.phase, 'day');
  s = run(s, [adv]);
  s = run(s, s.votes.voters.map((v) => vote(v, v === 'p3' ? 'p4' : 'p3')).concat([adv])); // 村人p3処刑: 1 vs 2
  assert.equal(s.phase, 'night');
  s = run(s, [act('p1', 'attack', 'p4'), adv]); // 1 vs 1（狂人）
  assert.equal(s.phase, 'end');
  assert.deepEqual(s.result.teams, ['werewolf']);
  assert.deepEqual(s.result.winners.sort(), ['p1', 'p5']);
});

test('勝利判定は夜明けにも行う（襲撃で決着）', () => {
  let s = ackAll(game(['werewolf', 'villager', 'villager', 'seer'], { firstNightAttack: true }));
  s = run(s, [act('p4', 'divine', 'p2'), act('p1', 'attack', 'p2'), adv]);
  assert.equal(s.phase, 'day'); // 1 vs 2
  s = run(s, [adv]);
  s = run(s, s.votes.voters.map((v) => vote(v, v === 'p3' ? 'p4' : 'p3')).concat([adv]));
  assert.equal(s.phase, 'end'); // 1 vs 1
  assert.deepEqual(s.result.teams, ['werewolf']);
});

test('妖狐: 襲撃では死なず、占われると死ぬ（呪殺）。結果は人間', () => {
  let s = ackAll(game(['werewolf', 'seer', 'fox', 'villager', 'villager', 'villager', 'werewolf'], { firstNightAttack: true }));
  s = run(s, [act('p2', 'divine', 'p4'), act('p1', 'attack', 'p3'), act('p7', 'attack', 'p3'), adv]);
  assert.ok(s.players.find((p) => p.id === 'p3').alive);
  assert.equal(events(s, 'attackBlocked')[0].data.by, 'immune');

  let t = ackAll(game(['werewolf', 'seer', 'fox', 'villager', 'villager', 'villager', 'werewolf'], { firstNightAttack: true }));
  t = run(t, [act('p2', 'divine', 'p3'), act('p1', 'attack', 'p2'), act('p7', 'attack', 'p2'), adv]);
  assert.equal(events(t, 'divineResult')[0].data.result, 'human');
  // 占い師は襲撃で死んでも、その夜の占いは成立して呪殺が起きる
  assert.deepEqual(events(t, 'dawn')[0].data.deaths, ['p2', 'p3']);
});

test('妖狐: 決着時に生きていれば勝利を奪う', () => {
  let s = ackAll(game(['werewolf', 'seer', 'fox', 'villager', 'villager']));
  s = run(s, [act('p2', 'divine', 'p4'), adv, adv]);
  s = run(s, s.votes.voters.map((v) => vote(v, v === 'p1' ? 'p2' : 'p1')).concat([adv]));
  assert.equal(s.phase, 'end');
  assert.deepEqual(s.result.teams, ['fox']);
  assert.deepEqual(s.result.winners, ['p3']);
});

test('初日の占い: お告げ(randomWhite)は人間を1人知らせ、自分で占う行動はない', () => {
  let s = ackAll(game(SEVEN, { firstNightDivine: 'randomWhite' }));
  const r = events(s, 'divineResult');
  assert.equal(r.length, 1);
  assert.equal(r[0].data.oracle, true);
  const target = s.players.find((p) => p.id === r[0].data.targetId);
  assert.notEqual(target.roleId, 'werewolf');
  assert.deepEqual(E.availableActions(E.makeCtx(s, S), 'p2'), []);
  let n = ackAll(game(SEVEN, { firstNightDivine: 'none' }));
  assert.deepEqual(E.availableActions(E.makeCtx(n, S), 'p2'), []);
});

test('見え方: 公開ビューには役職も個人の結果も出ない。終了後は全員分が見える', () => {
  let s = ackAll(game(SEVEN));
  s = run(s, [act('p2', 'divine', 'p1')]);
  const pub = E.view(s, S, 'public');
  assert.ok(pub.players.every((p) => p.roleId === null));
  assert.ok(pub.log.every((e) => e.visibleTo === 'all'));
  assert.equal(pub.pending, undefined);
  const gm = E.view(s, S, 'gm');
  assert.ok(gm.players.every((p) => p.roleId));
  assert.ok(Array.isArray(gm.pending));
});

test('死亡時に役職公開の設定', () => {
  let s = ackAll(game(SEVEN, { revealRoleOnDeath: true }));
  s = toSecondNight(s, 'p5');
  const v = E.view(s, S, 'p6');
  assert.equal(v.players.find((p) => p.id === 'p5').roleId, 'villager');
});

test('状態は JSON のまま保存・復元できる', () => {
  let s = ackAll(game(SEVEN));
  const restored = JSON.parse(JSON.stringify(s));
  const a = run(s, [act('p2', 'divine', 'p1'), adv]);
  const b = run(restored, [act('p2', 'divine', 'p1'), adv]);
  assert.deepEqual(a, b);
});

test('dispatch は元の状態を書き換えない', () => {
  const s = ackAll(game(SEVEN));
  const before = JSON.stringify(s);
  E.dispatch(s, S, act('p2', 'divine', 'p1'));
  E.dispatch(s, S, adv);
  assert.equal(JSON.stringify(s), before);
});
