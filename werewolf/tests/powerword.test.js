'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, S, game, run, ackAll, adv, act, vote, events } = require('./helpers.js');
const P = require('../rules/powerword.js');
const W = require('../rules/powerwords.js').words;

const SEVEN = ['werewolf', 'seer', 'knight', 'medium', 'villager', 'villager', 'werewolf'];
const G = (cfg) => ackAll(game(SEVEN, cfg, P), P);
const words = (ev) => Object.values(ev.data.words).map((w) => w.text);

test('語彙: 数十〜百個、重複なし、種類と難しさが付いている', () => {
  assert.ok(W.length >= 60 && W.length <= 100, '個数 ' + W.length);
  assert.equal(new Set(W.map((w) => w.text)).size, W.length);
  W.forEach((w) => {
    assert.ok(w.text && !/\s/.test(w.text), w.text);
    assert.ok(w.kind);
    assert.ok([1, 2, 3].includes(w.level), w.text);
  });
  [1, 2, 3].forEach((l) => assert.ok(W.filter((w) => w.level === l).length >= 10, 'level' + l));
});

test('配布: 夜の始まりに人狼だけへ配られ、他の人には見えない', () => {
  const s = G({});
  const given = events(s, 'powerWordGiven');
  assert.equal(given.length, 1);
  assert.deepEqual(given[0].visibleTo, ['p1', 'p7']);
  assert.deepEqual(Object.keys(given[0].data.words).sort(), ['p1', 'p7']);
  assert.equal(E.view(s, P, 'p1').log.filter((e) => e.type === 'powerWordGiven').length, 1);
  assert.equal(E.view(s, P, 'p7').log.filter((e) => e.type === 'powerWordGiven').length, 1);
  for (const id of ['p2', 'p3', 'p4', 'p5', 'p6', 'public']) {
    assert.equal(E.view(s, P, id).log.filter((e) => e.type === 'powerWordGiven').length, 0, id);
  }
});

test('既定は人狼全員が同じワード。設定で人狼ごとに別のワードにできる', () => {
  const a = events(G({}), 'powerWordGiven')[0];
  assert.equal(new Set(words(a)).size, 1);
  const s = G({ powerWordShared: false });
  const b = events(s, 'powerWordGiven');
  assert.equal(b.length, 2);
  assert.deepEqual(b.map((e) => e.visibleTo), [['p1'], ['p7']]);
  assert.notEqual(words(b[0])[0], words(b[1])[0]);
  assert.equal(E.view(s, P, 'p1').log.filter((e) => e.type === 'powerWordGiven').length, 1);
});

test('公開: 次の夜が明けた朝に、前日のワードが全員へ公開される（公開前は見えない）', () => {
  let s = G({});
  const w1 = words(events(s, 'powerWordGiven')[0])[0];
  s = run(s, [act('p2', 'divine', 'p5'), adv], P); // 初日夜 → 朝
  assert.equal(events(s, 'powerWordReveal').length, 0, '最初の朝は公開なし');
  s = run(s, [adv], P); // 昼 → 投票
  s = run(s, s.votes.voters.map((v) => vote(v, v === 'p5' ? 'p6' : 'p5')).concat([adv]), P);
  assert.equal(s.phase, 'night');
  assert.equal(events(s, 'powerWordReveal').length, 0, '次の夜が明けるまで公開されない');
  const w2 = words(events(s, 'powerWordGiven')[1])[0];
  assert.notEqual(w1, w2, '連続して同じワードにならない');
  s = run(s, [act('p2', 'divine', 'p1'), act('p3', 'guard', 'p6'), act('p1', 'attack', 'p6'), act('p7', 'attack', 'p6'), adv], P);
  const rev = events(s, 'powerWordReveal');
  assert.equal(rev.length, 1);
  assert.equal(rev[0].visibleTo, 'all');
  assert.equal(Object.values(rev[0].data.words)[0].text, w1, '公開されるのは前日のワード');
  assert.equal(E.view(s, P, 'public').log.filter((e) => e.type === 'powerWordReveal').length, 1);
});

test('終了: 決着したとき、使われなかった最後のワードも公開される', () => {
  let s = ackAll(game(['werewolf', 'seer', 'villager', 'villager', 'madman'], {}, P), P);
  const w1 = words(events(s, 'powerWordGiven')[0])[0];
  s = run(s, [act('p2', 'divine', 'p3'), adv, adv], P);
  s = run(s, s.votes.voters.map((v) => vote(v, v === 'p1' ? 'p2' : 'p1')).concat([adv]), P);
  assert.equal(s.phase, 'end');
  const rev = events(s, 'powerWordReveal');
  assert.equal(rev.length, 1);
  assert.equal(rev[0].data.final, true);
  assert.equal(Object.values(rev[0].data.words)[0].text, w1);
});

test('配布: 死んだ人狼には配られない。人狼がいなければ配られない', () => {
  let s = G({ firstNightAttack: true, powerWordShared: false });
  s = run(s, [act('p2', 'divine', 'p5'), act('p1', 'attack', 'p5'), act('p7', 'attack', 'p5'), act('p3', 'guard', 'p6'), adv, adv], P);
  s = run(s, s.votes.voters.map((v) => vote(v, v === 'p7' ? 'p6' : 'p7')).concat([adv]), P);
  assert.equal(s.phase, 'night');
  const last = events(s, 'powerWordGiven').pop();
  assert.deepEqual(Object.keys(last.data.words), ['p1']);
});

test('語彙の難しさの上限を設定できる', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const s = E.createGame(P, { players: SEVEN.map((r, i) => ({ name: 'P' + i })), config: { powerWordMaxLevel: 1 }, seed,
      roleCounts: { werewolf: 2, seer: 1, knight: 1, medium: 1, villager: 2 } });
    const t = ackAll(s, P);
    const w = Object.values(events(t, 'powerWordGiven')[0].data.words)[0].text;
    assert.equal(W.find((x) => x.text === w).level, 1, w);
  }
});

test('同じ種なら同じワード（再現できる）', () => {
  const mk = () => E.createGame(P, { players: SEVEN.map((r, i) => ({ name: 'P' + i })), seed: 99 });
  const a = ackAll(mk(), P), b = ackAll(mk(), P);
  assert.deepEqual(events(a, 'powerWordGiven')[0].data, events(b, 'powerWordGiven')[0].data);
});

// ---- 総当たり: ランダムに遊ばせて、必ず決着し、ワードが1回も重複しないこと ----
function randomPlay(ruleset, seed, n, cfg) {
  let s = E.createGame(ruleset, { players: Array.from({ length: n }, (_, i) => ({ name: 'P' + i })), seed, config: cfg });
  const rnd = (() => { let x = seed; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296; })();
  let guard = 0;
  while (!s.result && guard++ < 400) {
    const ctx = E.makeCtx(E.clone(s), ruleset);
    const cmds = [];
    if (s.phase === 'reveal') s.players.forEach((p) => cmds.push({ type: 'ack', playerId: p.id }));
    s.players.forEach((p) => E.availableActions(ctx, p.id).forEach((a) => {
      if (a.targets.length) cmds.push(act(p.id, a.actionId, a.targets[Math.floor(rnd() * a.targets.length)]));
    }));
    if (s.votes) s.votes.voters.forEach((v) => {
      const opts = E.view(s, ruleset, v).vote.myOptions;
      cmds.push(vote(v, opts[Math.floor(rnd() * opts.length)]));
    });
    cmds.push({ type: 'advance', force: true });
    for (const c of cmds) {
      const r = E.dispatch(s, ruleset, c);
      if (r.ok) s = r.state;
      else if (c.type === 'advance') throw new Error('advance 失敗: ' + r.error);
      if (s.result) break;
    }
  }
  return s;
}

test('総当たり: 4〜15人・200ゲームのランダムプレイが、どちらのルールでも必ず決着する', () => {
  let games = 0;
  for (const rs of [S, P]) {
    for (let n = 4; n <= 15; n++) {
      for (let seed = 1; seed <= 8; seed++) {
        const s = randomPlay(rs, seed * 7919 + n, n, { firstNightAttack: seed % 2 === 0, powerWordShared: seed % 3 !== 0 });
        assert.ok(s.result, rs.id + ' n=' + n + ' seed=' + seed + ' が終わらない');
        assert.ok(s.result.winners.length >= 1);
        if (rs === P) {
          const all = events(s, 'powerWordReveal');
          const texts = [].concat(...all.map((e) => words(e)));
          const given = [].concat(...events(s, 'powerWordGiven').map((e) => words(e)));
          assert.ok(texts.length >= 1 || given.length === 0);
          // 配られたワードは最後にすべて公開されている（重複を除いて）
          given.forEach((t) => assert.ok(texts.includes(t), '未公開のワード ' + t));
        }
        games++;
      }
    }
  }
  assert.ok(games >= 190, games + ' ゲーム');
});
