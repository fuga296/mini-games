'use strict';
const E = require('../core/engine.js');
const S = require('../rules/standard.js');

/** 役職を固定して作る。roles は席順の役職ID配列 */
function game(roles, config, ruleset) {
  const rs = ruleset || S;
  const counts = {};
  roles.forEach((r) => { counts[r] = (counts[r] || 0) + 1; });
  const assign = {};
  roles.forEach((r, i) => { assign[i] = r; });
  return E.createGame(rs, {
    players: roles.map((r, i) => ({ name: 'P' + (i + 1) })),
    config: config || {},
    seed: 42,
    roleCounts: counts,
    assign,
  });
}

/** 命令を順に通す。失敗したら例外 */
function run(state, cmds, ruleset) {
  const rs = ruleset || S;
  for (const c of cmds) {
    const r = E.dispatch(state, rs, c);
    if (!r.ok) throw new Error(JSON.stringify(c) + ' => ' + r.error);
    state = r.state;
  }
  return state;
}

function ackAll(state, ruleset) {
  return run(state, state.players.map((p) => ({ type: 'ack', playerId: p.id })).concat([{ type: 'advance' }]), ruleset);
}

const adv = { type: 'advance' };
const act = (playerId, actionId, targetId) => ({ type: 'act', playerId, actionId, targetId });
const vote = (playerId, targetId) => ({ type: 'vote', playerId, targetId });
const alive = (state) => state.players.filter((p) => p.alive).map((p) => p.id);
const events = (state, type) => state.log.filter((e) => e.type === type);

module.exports = { E, S, game, run, ackAll, adv, act, vote, alive, events };
