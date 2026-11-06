/*
 * 画面（ブラウザ専用）。ゲームのルールはここに書かない。
 * 画面が見るのは session.view(誰の目線か) だけ。操作は session.dispatch(誰が, 何を) だけ。
 *
 * 遊び方
 *   pass : スマホ1台を回す。秘密の画面の前には必ず「〇〇さんに渡してください」をはさむ。
 *   gm   : 司会役の支援。司会がスマホを持ち、台本を読みながら全員の行動を入力する。
 */
(function () {
  'use strict';
  var WW = globalThis.WW;
  var RULESETS = { standard: WW.standard, powerword: WW.powerword };
  var RULE_INFO = {
    standard: '役職と話し合いだけで進む、基本の人狼。',
    powerword: '毎晩、人狼にだけ「パワーワード」が配られます。人狼は次の昼の話し合いでそれを自然に使わなければならず、言葉は翌朝に全員へ明かされます。',
  };
  var E = WW.engine, RS = RULESETS.standard, T = WW.textJa, Session = WW.session;
  function setRules(id) { RS = RULESETS[id] || RULESETS.standard; }
  var SAVE_KEY = 'werewolf.save.v1';
  var NAMES_KEY = 'werewolf.names.v1';
  var SETTINGS_KEY = 'werewolf.settings.v1';

  // 画面だけで使う設定（ゲームのルールではないもの）
  var UI_DEFAULTS = {
    secretVote: true,     // スマホを回す形で、投票も1人ずつ秘密に入力する
    dummyAction: true,    // 能力のない人にも夜に「選ぶ」操作をさせ、誰が能力者か分からなくする
  };

  // 設定項目（画面に出す順）。値はルールセットの defaultConfig / UI_DEFAULTS に入る
  var CONFIG_FIELDS = [
    { key: 'discussionSeconds', label: '昼の話し合い時間', type: 'select', options: [[60, '1分'], [120, '2分'], [180, '3分'], [240, '4分'], [300, '5分'], [420, '7分'], [600, '10分']] },
    { key: 'firstNightAttack', label: '初日の夜の襲撃', type: 'select', options: [[false, 'なし'], [true, 'あり']] },
    { key: 'firstNightDivine', label: '初日の夜の占い', type: 'select', options: [['free', '自由に占う'], ['randomWhite', 'お告げ（ランダムな人間を1人）'], ['none', 'なし']] },
    { key: 'consecutiveGuard', label: '騎士の連続護衛', type: 'select', options: [[false, '不可'], [true, '可']] },
    { key: 'selfGuard', label: '騎士の自分護衛', type: 'select', options: [[false, '不可'], [true, '可']] },
    { key: 'tieRule', label: '投票が同数のとき', type: 'select', options: [['runoff', '決選投票'], ['random', 'ランダムで処刑'], ['none', '処刑なし']] },
    { key: 'runoffTie', label: '決選投票も同数のとき', type: 'select', options: [['random', 'ランダムで処刑'], ['none', '処刑なし']] },
    { key: 'aggregateTie', label: '人狼の襲撃先が割れたとき', type: 'select', options: [['random', '候補からランダム'], ['none', '襲撃なし']] },
    { key: 'voteReveal', label: '投票結果の公開', type: 'select', options: [['open', '誰が誰に入れたか'], ['count', '票数だけ']] },
    { key: 'allowSelfVote', label: '自分への投票', type: 'select', options: [[false, '不可'], [true, '可']] },
    { key: 'revealRoleOnDeath', label: '死亡時の役職公開', type: 'select', options: [[false, '公開しない'], [true, '公開する']] },
    { key: 'powerWordShared', rules: ['powerword'], label: 'パワーワードの配り方', type: 'select', options: [[true, '人狼全員が同じワード'], [false, '人狼ごとに別のワード']] },
    { key: 'powerWordMaxLevel', rules: ['powerword'], label: 'パワーワードの難しさ', type: 'select', options: [[1, '自然に言えるものだけ'], [2, 'ふつうまで'], [3, '不自然になりがちなものも']] },
    { key: 'secretVote', ui: true, label: '投票のしかた（スマホを回す形）', type: 'select', options: [[true, '1人ずつ秘密に入力'], [false, '指差しでまとめて入力']] },
    { key: 'dummyAction', ui: true, label: '能力のない人の夜の操作', type: 'select', options: [[true, 'ダミーの選択をさせる'], [false, '確認だけ']] },
  ];

  // ---------------- 状態 ----------------
  var app = {
    screen: 'home',     // home | setup | game | rules
    mode: 'pass',
    session: null,
    ui: Object.assign({}, UI_DEFAULTS),
    setup: null,
    flow: null,         // スマホを回す順番 { key, queue:[ids], i, stage:'handoff'|'private' }
    pick: null,         // 秘密画面で選んでいる対象（確定前）
    announce: null,     // 発表画面 { title, lines:[], button }
    gmVotes: {},        // 司会/まとめ入力の投票の下書き
    timer: { remaining: null, running: false, endAt: 0, key: null },
    showLog: false,
    peek: null,         // 昼に、自分の役職やワードをこっそり見る { stage:'pick'|'show', pid }
  };

  // ---------------- 保存 ----------------
  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 保存できない環境でも遊べる */ } }
  function load(key) { try { var s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function drop(key) { try { localStorage.removeItem(key); } catch (e) { /* noop */ } }
  function save() {
    if (!app.session) return;
    store(SAVE_KEY, { mode: app.mode, ui: app.ui, state: app.session.snapshot(), flow: app.flow, announce: app.announce });
  }

  // ---------------- 小道具 ----------------
  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(sel) { return document.querySelector(sel); }
  function gmView() { return app.session.view(E.VIEWER_GM); }
  function pubView() { return app.session.view(E.VIEWER_PUBLIC); }
  function role(id) { return RS.roles[id]; }
  function teamClass(teamId) { return teamId === 'werewolf' ? 'wolf' : teamId === 'fox' ? 'fox' : 'village'; }
  function btn(label, action, attrs, cls) {
    return '<button class="btn ' + (cls || '') + '" data-action="' + action + '" ' + (attrs || '') + '>' + label + '</button>';
  }
  function actor() { return app.mode === 'gm' ? { kind: 'gm' } : { kind: 'host' }; }
  function as(pid) { return app.mode === 'gm' ? { kind: 'gm' } : { kind: 'player', playerId: pid }; }

  function send(who, cmd) {
    var r = app.session.dispatch(who, cmd);
    if (!r.ok) { toast(r.error); return null; }
    save();
    return r;
  }
  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  /** 進行して、増えた公開の記録を発表画面にする */
  function advance(force, title) {
    var r = send(actor(), { type: 'advance', force: !!force });
    if (!r) return;
    var pv = pubView();
    var lines = [];
    var ballotLines = [];
    var ended = pv.phase === 'end';
    r.events.forEach(function (ev) {
      if (ev.visibleTo !== 'all') return;
      var t = T.formatEvent(ev, pv, RS);
      // 朝の発表は昼の画面に出すので、決着したときだけここに出す
      if (t && ev.type !== 'gameEnd' && ev.type !== 'death' && (ev.type !== 'dawn' || ended)) lines.push(t);
      if (ev.type === 'voteResult') ballotLines = ballotLines.concat(T.ballotLines(ev, pv));
    });
    app.flow = null;
    app.pick = null;
    app.gmVotes = {};
    if ((title || ended) && lines.length) {
      app.announce = { title: title || '朝', lines: lines, sub: ballotLines };
    }
    save();
    render();
  }

  // ---------------- 画面: ホーム ----------------
  function renderHome() {
    var saved = load(SAVE_KEY);
    var resume = saved && saved.state && !saved.state.result
      ? '<div class="card"><p>前回のゲームが途中です。</p>' + btn('続きから遊ぶ', 'resume', '', 'primary') + btn('破棄する', 'discard', '', 'ghost') + '</div>'
      : '';
    return '<header class="title"><div class="lead"><p>この村に、<br>人ならざるものが<br>紛れている。</p>' +
      '<p class="quiet">スマホ1台で遊ぶ、推理のゲーム。</p></div><h1 aria-label="人狼"><span>人</span><span>狼</span></h1></header>' +
      resume +
      '<div class="modes">' +
      '<button class="mode" data-action="new" data-mode="pass"><b>スマホ1台を回す</b><span>司会なし。秘密の画面は本人だけが見ます。夜も全員が順番にスマホを持ちます。</span></button>' +
      '<button class="mode" data-action="new" data-mode="gm"><b>司会役の支援</b><span>司会が1人つき、スマホを持ちます。台本を読みながら、夜の行動や投票を入力します。</span></button>' +
      '</div>' +
      '<div class="card">' + btn('ルールと役職の説明', 'rules', '', 'ghost') + '</div>';
  }

  function renderRules() {
    setRules('standard');
    var list = RS.roleOrder.map(function (id) {
      var r = role(id);
      return '<li><b class="' + teamClass(r.team) + '">' + h(r.name) + '</b>（' + h(RS.teams[r.team].name) + '）<br>' + h(r.description) + '</li>';
    }).join('');
    return '<div class="card"><h2>流れ</h2><ol class="flow">' +
      '<li>全員が自分の役職をこっそり確認します。</li>' +
      '<li><b>夜</b>：人狼は1人を襲撃、占い師は1人を占い、騎士は1人を守ります。</li>' +
      '<li><b>朝</b>：犠牲者が発表されます。</li>' +
      '<li><b>昼</b>：話し合い、投票で1人を処刑します。</li>' +
      '<li>人狼が全滅すれば村人陣営の勝ち。人狼の数が人間（人狼以外）の数以上になれば人狼陣営の勝ち。</li>' +
      '</ol></div><div class="card"><h2>パワーワード人狼</h2><p>' + h(RULE_INFO.powerword) + '</p><p class="hint">準備の画面で、ゲームの種類として選べます。</p></div><div class="card"><h2>役職</h2><ul class="roles">' + list + '</ul></div>' +
      '<div class="card">' + btn('戻る', 'home', '', 'ghost') + '</div>';
  }

  // ---------------- 画面: 準備 ----------------
  function initSetup(mode) {
    var names = load(NAMES_KEY) || ['', '', '', '', '', ''];
    var settings = load(SETTINGS_KEY) || {};
    app.mode = mode;
    setRules(settings.rulesId);
    app.ui = Object.assign({}, UI_DEFAULTS, settings.ui || {});
    app.setup = {
      rulesId: RS.id,
      names: names.slice(0, RS.maxPlayers),
      config: Object.assign({}, RS.defaultConfig, settings.config || {}),
      auto: true,
      counts: null,
    };
    syncCounts();
  }
  function syncCounts() {
    var n = app.setup.names.length;
    if (app.setup.auto || !app.setup.counts) app.setup.counts = RS.presetFor(Math.max(n, RS.minPlayers));
  }
  function setupNames() {
    return app.setup.names.map(function (nm, i) { return nm.trim() || ('プレイヤー' + (i + 1)); });
  }

  function renderSetup() {
    var s = app.setup;
    var n = s.names.length;
    var players = s.names.map(function (nm, i) {
      return '<div class="row"><span class="seat">' + (i + 1) + '</span>' +
        '<input class="name" data-index="' + i + '" maxlength="12" placeholder="プレイヤー' + (i + 1) + '" value="' + h(nm) + '">' +
        '<button class="icon" data-action="removePlayer" data-index="' + i + '" aria-label="削除">×</button></div>';
    }).join('');
    var total = 0;
    var roles = RS.roleOrder.map(function (id) {
      var c = s.counts[id] || 0;
      total += c;
      return '<div class="row stepper"><span class="rname ' + teamClass(role(id).team) + '">' + h(role(id).name) + '</span>' +
        '<button class="icon" data-action="count" data-role="' + id + '" data-delta="-1">−</button>' +
        '<span class="num">' + c + '</span>' +
        '<button class="icon" data-action="count" data-role="' + id + '" data-delta="1">＋</button></div>';
    }).join('');
    var err = RS.validateRoles(n, s.counts);
    var fields = CONFIG_FIELDS.filter(function (f) { return !(f.ui && app.mode === 'gm' && f.key === 'secretVote') && !(f.ui && app.mode === 'gm' && f.key === 'dummyAction') && (!f.rules || f.rules.indexOf(RS.id) >= 0); })
      .map(function (f) {
        var val = f.ui ? app.ui[f.key] : s.config[f.key];
        var opts = f.options.map(function (o) {
          return '<option value="' + h(JSON.stringify(o[0])) + '"' + (JSON.stringify(o[0]) === JSON.stringify(val) ? ' selected' : '') + '>' + h(o[1]) + '</option>';
        }).join('');
        return '<label class="field"><span>' + h(f.label) + '</span><select data-config="' + f.key + '" data-ui="' + (f.ui ? 1 : 0) + '">' + opts + '</select></label>';
      }).join('');
    return '<div class="card"><h2>' + (app.mode === 'gm' ? '司会役の支援' : 'スマホ1台を回す') + '：準備</h2>' +
      '<label class="field"><span>ゲームの種類</span><select data-rules="1">' +
      Object.keys(RULESETS).map(function (id) { return '<option value="' + id + '"' + (RS.id === id ? ' selected' : '') + '>' + h(RULESETS[id].name) + '</option>'; }).join('') +
      '</select></label><p class="ruleinfo">' + h(RULE_INFO[RS.id]) + '</p>' +
      '<h3>参加者（' + n + '人）' + (app.mode === 'gm' ? '<small>司会は含めません</small>' : '') + '</h3>' +
      '<p class="hint">座っている順に入力してください。夜にスマホを回す順になります。</p>' +
      players +
      (n < RS.maxPlayers ? btn('＋ 参加者を追加', 'addPlayer', '', 'ghost') : '') +
      '</div>' +
      '<div class="card"><h3>配役 <small>合計 ' + total + ' / ' + n + '人</small></h3>' +
      '<label class="check"><input type="checkbox" data-action="auto"' + (s.auto ? ' checked' : '') + '> 人数に合わせておすすめの配役にする</label>' +
      roles +
      (err ? '<p class="error">' + h(err) + '</p>' : '') +
      '</div>' +
      '<details class="card"><summary>細かいルール</summary>' + fields +
      btn('既定に戻す', 'resetConfig', '', 'ghost small') + '</details>' +
      '<div class="card">' + btn('ゲームを始める', 'start', err ? 'disabled' : '', 'primary') + btn('戻る', 'home', '', 'ghost') + '</div>';
  }

  function startGame() {
    var names = setupNames();
    store(NAMES_KEY, app.setup.names);
    store(SETTINGS_KEY, { rulesId: RS.id, config: app.setup.config, ui: app.ui });
    var state;
    try {
      state = E.createGame(RS, {
        players: names.map(function (n) { return { name: n }; }),
        config: app.setup.config,
        roleCounts: app.setup.counts,
        seed: Date.now() ^ Math.floor(Math.random() * 0xffffffff),
      });
    } catch (e) { toast(e.message); return; }
    app.session = Session.createLocalSession(RS, state);
    app.flow = null; app.announce = null; app.pick = null; app.gmVotes = {};
    app.screen = 'game';
    save();
    render();
  }

  // ---------------- 画面: ゲーム共通 ----------------
  function header(v) {
    var alive = v.players.filter(function (p) { return p.alive; }).length;
    return '<div class="bar ' + (v.phase === 'night' ? 'night' : 'dayc') + '"><b>' + h(v.phaseLabel) + '</b><span>生存 ' + alive + ' / ' + v.players.length + '人</span>' +
      '<button class="icon menu" data-action="menu" aria-label="メニュー">≡</button></div>';
  }

  function playerChips(v, opts) {
    opts = opts || {};
    return '<div class="chips">' + v.players.map(function (p) {
      var r = p.roleId ? role(p.roleId) : null;
      var tag = r && opts.roles ? '<em class="' + teamClass(r.team) + '">' + h(r.name) + '</em>' : '';
      var win = opts.winners && opts.winners.indexOf(p.id) >= 0 ? ' win' : '';
      return '<span class="chip' + (p.alive ? '' : ' dead') + win + '">' + h(p.name) + tag + '</span>';
    }).join('') + '</div>';
  }

  function logList(v, filter) {
    var items = v.log.filter(filter || function () { return true; }).map(function (ev) {
      var t = T.formatEvent(ev, v, RS);
      if (!t) return '';
      var secret = ev.visibleTo !== 'all' ? ' class="secret"' : '';
      var sub = ev.type === 'voteResult' ? T.ballotLines(ev, v).map(function (l) { return '<div class="sub">' + h(l) + '</div>'; }).join('') : '';
      return '<li' + secret + '><span class="d">' + h(T.dayLabel(ev.day)) + '</span>' + h(t) + sub + '</li>';
    }).join('');
    return '<ul class="log">' + (items || '<li>まだ記録はありません</li>') + '</ul>';
  }

  function targetButtons(v, ids, action, selected, extra) {
    return '<div class="targets">' + ids.map(function (id) {
      return '<button class="target' + (selected === id ? ' on' : '') + '" data-action="' + action + '" data-target="' + id + '" ' + (extra || '') + '>' + h(T.nameOf(v, id)) + '</button>';
    }).join('') + '</div>';
  }

  function renderGame() {
    var pv = pubView();
    if (app.announce) return renderAnnounce(pv);
    if (app.peek && app.mode === 'pass') return renderPeek(pv);
    if (pv.phase === 'end') return renderEnd();
    if (app.mode === 'pass') return renderPass(pv);
    return renderGM();
  }

  function renderPeek(pv) {
    if (app.peek.stage === 'pick') {
      return header(pv) + '<div class="card"><h2>こっそり確認する</h2><p class="hint">自分の名前を選んでください。周りの人は、画面を見ないでください。</p>' +
        targetButtons(pv, pv.players.map(function (p) { return p.id; }), 'peekPick', null) + '</div>' +
        '<div class="card sticky">' + btn('やめる', 'peekClose', '', 'ghost') + '</div>';
    }
    var v = app.session.view(app.peek.pid);
    var lastWord = null;
    v.log.forEach(function (ev) { if (ev.type === 'powerWordGiven' && myWord(v, ev)) lastWord = ev; });
    var now = lastWord && v.phase === 'day' && lastWord.day === v.day - 1
      ? wordBlock(myWord(v, lastWord), 'いまの昼に使うべきワード') : '';
    return header(v) + '<div class="card private">' + roleCard(v) + now + '</div>' + privateNotesCard(v) +
      '<div class="card sticky">' + btn('閉じる（スマホを机に戻す）', 'peekClose', '', 'primary') + '</div>';
  }

  function renderAnnounce(pv) {
    var a = app.announce;
    return '<div class="card announce"><h2>' + h(a.title) + '</h2>' +
      a.lines.map(function (l) { return '<p class="big">' + h(l) + '</p>'; }).join('') +
      (a.sub && a.sub.length ? '<div class="ballots">' + a.sub.map(function (l) { return '<div>' + h(l) + '</div>'; }).join('') + '</div>' : '') +
      '</div><div class="card sticky">' + btn('次へ', 'closeAnnounce', '', 'primary') + '</div>';
  }

  function renderEnd() {
    var gv = gmView();
    var res = gv.result;
    var teams = res.teams.map(function (t) { return RS.teams[t].name; }).join('・');
    var cls = teamClass(res.teams[0]);
    return header(gv) + '<div class="card end ' + cls + '"><h2>' + h(teams) + 'の勝利</h2><p>' + h(res.reason) + '</p></div>' +
      '<div class="card"><h3>配役（★は勝者）</h3>' + playerChips(gv, { roles: true, winners: res.winners }) + '</div>' +
      '<div class="card"><h3>すべての記録</h3>' + logList(gv) + '</div>' +
      '<div class="card sticky">' + btn('同じメンバーでもう一度', 'again', '', 'primary') + btn('最初の画面へ', 'quit', '', 'ghost') + '</div>';
  }

  // ---------------- スマホを回す形 ----------------
  function passQueue(pv) {
    var gv = gmView();
    var key = pv.phase + ':' + pv.day;
    if (app.flow && app.flow.key === key) return app.flow;
    var ids;
    if (pv.phase === 'reveal') ids = pv.players.map(function (p) { return p.id; });
    else if (pv.phase === 'night') ids = pv.players.filter(function (p) { return p.alive; }).map(function (p) { return p.id; });
    else if (pv.vote) ids = gv.vote.voters.slice();
    else ids = [];
    app.flow = { key: key, queue: ids, i: 0, stage: 'handoff' };
    save();
    return app.flow;
  }

  function handoffCard(name, i, total, lead) {
    return '<div class="card handoff"><p class="step">' + (i + 1) + ' / ' + total + '</p>' +
      '<div class="seal" aria-hidden="true">' + h(String(name).charAt(0)) + '</div>' +
      '<p class="who">' + h(name) + '</p><p class="to">さんの手に、スマホを渡してください。</p>' +
      (lead ? '<p class="hint">' + h(lead) + '</p>' : '') + '</div>';
  }

  function renderPass(pv) {
    var secretPhase = pv.phase === 'reveal' || pv.phase === 'night' || (pv.vote && app.ui.secretVote);
    if (!secretPhase) return pv.vote ? renderOpenVote(pv, false) : renderDay(pv);
    var f = passQueue(pv);
    if (f.i >= f.queue.length) return renderPassDone(pv);
    var pid = f.queue[f.i];
    var name = T.nameOf(pv, pid);
    if (f.stage === 'handoff') {
      var lead = pv.phase === 'reveal' ? '自分の役職を確認します。周りの人は、画面を見ないでください。' : pv.phase === 'night' ? '夜の行動をします。周りの人は、画面を見ないでください。' : '投票します。周りの人は、画面を見ないでください。';
      return header(pv) + handoffCard(name, f.i, f.queue.length, lead) +
        '<div class="card sticky">' + btn('封を切る', 'openPrivate', '', 'primary') + '</div>';
    }
    var v = app.session.view(pid);
    if (pv.phase === 'reveal') return renderReveal(v);
    if (pv.phase === 'night') return renderNightPrivate(v);
    return renderSecretVote(v);
  }

  function roleCard(v) {
    var r = role(v.me.roleId);
    var allies = Object.keys(v.me.known).map(function (id) {
      var p = v.players.filter(function (x) { return x.id === id; })[0];
      return h(p.name) + '（' + h(role(v.me.known[id]).name) + (p.alive ? '' : '・死亡') + '）';
    });
    return '<div class="rolecard ' + teamClass(v.me.team) + '"><p class="small">' + h(v.me.name) + ' さんの役職</p>' +
      '<p class="rname-big">' + h(r.name) + '</p><p class="team">' + h(RS.teams[v.me.team].name) + '</p>' +
      '<p>' + h(r.description) + '</p>' +
      (allies.length ? '<p class="allies">仲間：' + allies.join('、') + '</p>' : '') + '</div>';
  }

  /** 人狼にだけ配られるパワーワードの札 */
  function wordBlock(word, caption) {
    return '<div class="result word"><small>' + h(caption) + '</small><b>' + h(word.text) + '</b><small>' + h(word.kind) + '</small></div>';
  }
  function myWord(v, ev) { return ev.data.words[v.me.id] || null; }

  function privateNotes(v) {
    var mine = v.log.filter(function (ev) { return Array.isArray(ev.visibleTo) && ev.type !== 'roleAssigned'; });
    if (!mine.length) return '';
    return '<div class="notes"><h3>あなただけが知っていること</h3>' + logList(v, function (ev) {
      return Array.isArray(ev.visibleTo) && ev.type !== 'roleAssigned';
    }) + '</div>';
  }

  function renderReveal(v) {
    return header(v) + '<div class="card private">' + roleCard(v) + '</div>' +
      '<div class="card sticky">' + btn('確認した（画面を閉じる）', 'ackReveal', 'data-player="' + v.me.id + '"', 'primary') + '</div>';
  }

  function renderNightPrivate(v) {
    var me = v.me;
    var body = '';
    var canClose = true;
    if (me.actions.length) {
      me.actions.forEach(function (a) {
        var txt = T.actionText[a.actionId] || { prompt: '対象を選んでください', done: '選択' };
        body += '<h3>' + h(txt.prompt) + '</h3>';
        if (a.allies && a.allies.length) {
          body += '<p class="hint">仲間の選択：' + a.allies.map(function (x) { return h(T.nameOf(v, x.playerId)) + ' → ' + h(T.nameOf(v, x.targetId)); }).join('、') + '</p>';
        }
        var locked = a.chosen !== null && RS.actions[a.actionId].changeable === false;
        if (locked) {
          body += '<p class="big">' + h(txt.done) + '：' + h(T.nameOf(v, a.chosen)) + '</p>';
        } else {
          body += targetButtons(v, a.targets, 'act', a.chosen, 'data-player="' + me.id + '" data-act="' + a.actionId + '"');
        }
        if (a.required && a.chosen === null) canClose = false;
      });
    } else if (app.ui.dummyAction) {
      body += '<h3>怪しいと思う人を1人選んでください</h3><p class="hint">（記録されません。誰に能力があるか分からなくするための操作です）</p>';
      body += targetButtons(v, v.players.filter(function (p) { return p.alive && p.id !== me.id; }).map(function (p) { return p.id; }), 'dummy', app.pick);
      if (!app.pick) canClose = false;
    } else {
      body += '<p>今夜あなたにできることはありません。</p>';
    }
    // 今夜わかったこと（占い結果・霊媒結果）
    var tonight = v.log.filter(function (ev) {
      return Array.isArray(ev.visibleTo) && ev.day === v.day && ev.phase === 'night';
    }).map(function (ev) {
      if (ev.type === 'powerWordGiven' && myWord(v, ev)) return wordBlock(myWord(v, ev), '明日の昼の話し合いで、このワードを自然に使うこと。他の人に気づかれないように。');
      return '<p class="result">' + h(T.formatEvent(ev, v, RS)) + '</p>';
    }).join('');
    return header(v) + '<div class="card private">' + roleCard(v) + tonight + body + '</div>' +
      privateNotesCard(v) +
      '<div class="card sticky">' + btn('終わった（画面を閉じる）', 'closePrivate', canClose ? '' : 'disabled', 'primary') + '</div>';
  }
  function privateNotesCard(v) {
    var n = privateNotes(v);
    return n ? '<details class="card"><summary>これまでの自分の記録</summary>' + n + '</details>' : '';
  }

  function renderSecretVote(v) {
    var vote = v.vote;
    return header(v) + '<div class="card private"><p class="small">' + h(v.me.name) + ' さんの投票</p>' +
      '<h3>処刑したい人を選んでください</h3>' +
      targetButtons(v, vote.myOptions, 'vote', vote.myBallot, 'data-player="' + v.me.id + '"') + '</div>' +
      '<div class="card sticky">' + btn('投票した（画面を閉じる）', 'closePrivate', vote.myBallot ? '' : 'disabled', 'primary') + '</div>';
  }

  function renderPassDone(pv) {
    var msg, label, title;
    if (pv.phase === 'reveal') { msg = '全員が役職を確認しました。スマホを机の真ん中に置いてください。'; label = '夜を始める'; }
    else if (pv.phase === 'night') { msg = '全員の夜の行動が終わりました。'; label = '朝にする'; }
    else { msg = '全員の投票が終わりました。'; label = '開票する'; title = pv.phase === 'runoff' ? '決選投票の結果' : '投票の結果'; }
    return header(pv) + '<div class="card handoff"><p>' + h(msg) + '</p></div>' +
      '<div class="card sticky">' + btn(label, 'advance', title ? 'data-title="' + h(title) + '"' : '', 'primary') +
      btn('最初の人からやり直す', 'restartQueue', '', 'ghost small') + '</div>';
  }

  // ---------------- 昼（共通） ----------------
  function renderDay(pv) {
    var dawn = pv.log.filter(function (e) { return e.type === 'dawn'; }).pop();
    var msg = dawn ? T.formatEvent(dawn, pv, RS) : '';
    var gm = app.mode === 'gm';
    var t = timerState(pv);
    var revealed = pv.config.revealRoleOnDeath;
    var gv = gm ? gmView() : null;
    // パワーワード人狼：前日のワードの公開と、今日人狼が使うべきワード（司会のみ）
    var rv = pv.log.filter(function (e) { return e.type === 'powerWordReveal' && e.day === pv.day && !e.data.final; }).pop();
    var revealCard = rv
      ? '<div class="card morning"><h3>昨日の人狼のパワーワード</h3><p class="big">' + rv.data.words.map(function (w) { return '「' + h(w.text) + '」'; }).join('') + '</p>' +
        '<p class="hint">人狼は、昨日の話し合いのどこかで、この言葉を使っていたはずです。</p></div>' : '';
    var todayWord = '';
    if (gm) {
      var given = gv.log.filter(function (e) { return e.type === 'powerWordGiven' && e.day === pv.day - 1; });
      if (given.length) todayWord = '<div class="card"><h3>今日、人狼が使うべきワード（司会だけが見る）</h3>' +
        given.map(function (e) { return '<div class="result word"><b>' + h(T.formatEvent(e, gv, RS).replace(/^[^：]*：/, '')) + '</b></div>'; }).join('') + '</div>';
    }
    var peekBtn = !gm ? '<div class="card">' + btn('こっそり自分の役職を確認する', 'peek', '', 'ghost small') + '</div>' : '';
    return header(pv) + revealCard +
      (gm ? '<div class="card script"><p>「' + h(T.script.nightEnd) + '」</p><p>「' + h(msg.replace(/^朝：/, '')) + '」</p><p>「' + h(T.script.dayStart) + '」</p></div>' : '<div class="card"><p class="big">' + h(msg.replace(/^朝：/, '')) + '</p></div>') +
      '<div class="card timer"><div class="time" id="time">' + fmtTime(t.remaining) + '</div>' +
      btn(t.running ? '一時停止' : '話し合い開始', 'timerToggle', '', t.running ? '' : 'primary') +
      btn('＋30秒', 'timerAdd', '', 'ghost small') + btn('リセット', 'timerReset', '', 'ghost small') + '</div>' +
      '<div class="card"><h3>参加者</h3>' + playerChips(gm ? gv : pv, { roles: gm || revealed }) + '</div>' + todayWord + peekBtn +
      (gm ? gmPanel() : '<details class="card"><summary>これまでの記録（全員に公開されたもの）</summary>' + logList(pv) + '</details>') +
      '<div class="card sticky">' + btn('投票へ進む', 'advance', '', 'primary') + '</div>';
  }

  function timerState(pv) {
    var key = pv.phase + ':' + pv.day;
    var t = app.timer;
    if (t.key !== key) { t.key = key; t.remaining = pv.config.discussionSeconds; t.running = false; }
    if (t.running) t.remaining = Math.max(0, Math.round((t.endAt - Date.now()) / 1000));
    return t;
  }
  function fmtTime(sec) { sec = Math.max(0, sec | 0); return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2); }
  setInterval(function () {
    var t = app.timer;
    if (!t.running) return;
    t.remaining = Math.max(0, Math.round((t.endAt - Date.now()) / 1000));
    var el = $('#time');
    if (el) { el.textContent = fmtTime(t.remaining); el.classList.toggle('low', t.remaining <= 10); }
    if (t.remaining <= 0) {
      t.running = false;
      try { if (navigator.vibrate) navigator.vibrate([300, 150, 300]); } catch (e) { /* noop */ }
      toast('話し合いの時間が終わりました');
      render();
    }
  }, 250);

  // ---------------- まとめて入力する投票（司会 / 指差し） ----------------
  function renderOpenVote(pv, gm) {
    var gv = gmView();
    var vote = gv.vote;
    Object.keys(vote.ballots).forEach(function (id) { if (!(id in app.gmVotes)) app.gmVotes[id] = vote.ballots[id]; });
    var rows = vote.voters.map(function (vid) {
      var opts = '<option value="">（未入力）</option>' + vote.optionsFor[vid].map(function (c) {
        return '<option value="' + c + '"' + (app.gmVotes[vid] === c ? ' selected' : '') + '>' + h(T.nameOf(gv, c)) + '</option>';
      }).join('');
      return '<label class="field"><span>' + h(T.nameOf(gv, vid)) + ' →</span><select data-vote="' + vid + '">' + opts + '</select></label>';
    }).join('');
    var counts = E.tally(Object.keys(app.gmVotes).map(function (k) { return app.gmVotes[k]; }));
    var summary = Object.keys(counts.counts).map(function (id) { return h(T.nameOf(gv, id)) + ' ' + counts.counts[id] + '票'; }).join('、');
    var filled = vote.voters.filter(function (id) { return app.gmVotes[id]; }).length;
    var title = pv.phase === 'runoff' ? '決選投票の結果' : '投票の結果';
    return header(pv) +
      '<div class="card script"><p>「' + h(T.script.voteStart) + '」</p>' +
      (pv.phase === 'runoff' ? '<p>候補：' + h(vote.candidates.map(function (c) { return T.nameOf(gv, c); }).join('、')) + '</p>' : '') + '</div>' +
      '<div class="card"><h3>誰が誰を指差したか（' + filled + ' / ' + vote.voters.length + '）</h3>' + rows +
      '<p class="hint">集計中：' + (summary || 'なし') + '</p></div>' +
      (gm ? gmPanel() : '') +
      '<div class="card sticky">' + btn('開票する', 'submitVotes', 'data-title="' + h(title) + '"' + (filled ? '' : ' disabled'), 'primary') +
      (filled < vote.voters.length ? '<p class="hint">未入力の人は棄権として数えます。</p>' : '') + '</div>';
  }

  function submitVotes(title) {
    var gv = gmView();
    var ok = true;
    gv.vote.voters.forEach(function (vid) {
      var t = app.gmVotes[vid];
      if (t && gv.vote.ballots[vid] !== t) {
        if (!send(app.mode === 'gm' ? { kind: 'gm' } : { kind: 'player', playerId: vid }, { type: 'vote', playerId: vid, targetId: t })) ok = false;
      }
    });
    if (!ok) return;
    advance(true, title);
  }

  // ---------------- 司会役の支援 ----------------
  function gmPanel() {
    var gv = gmView();
    return '<details class="card gm"><summary>司会メモ（全員の役職と秘密の記録）</summary>' +
      playerChips(gv, { roles: true }) + logList(gv) + '</details>';
  }

  function renderGM() {
    var gv = gmView();
    if (gv.phase === 'reveal') return renderGMReveal(gv);
    if (gv.phase === 'night') return renderGMNight(gv);
    if (gv.vote) return renderOpenVote(gv, true);
    return renderDay(pubView());
  }

  function renderGMReveal(gv) {
    // 役職の確認だけは、スマホを回して本人に見せる
    var f = passQueue(gv);
    if (f.i < f.queue.length) {
      var pid = f.queue[f.i];
      if (f.stage === 'handoff') {
        return header(gv) + '<div class="card script"><p>「' + h(T.script.revealGM) + '」</p></div>' +
          handoffCard(T.nameOf(gv, pid), f.i, f.queue.length, '') +
          '<div class="card sticky">' + btn('封を切る', 'openPrivate', '', 'primary') + '</div>';
      }
      return renderReveal(app.session.view(pid));
    }
    return header(gv) + '<div class="card handoff"><p>全員が役職を確認しました。スマホを司会に戻してください。</p></div>' +
      gmPanel() + '<div class="card sticky">' + btn('夜を始める', 'advance', '', 'primary') + '</div>';
  }

  function renderGMNight(gv) {
    var counts = gmView().log.filter(function (e) { return e.type === 'gameStart'; })[0].data.roleCounts;
    var steps = T.nightCalls.filter(function (c) { return counts[c.roleId]; }).map(function (c) {
      var holders = gv.players.filter(function (p) { return p.roleId === c.roleId && p.alive; });
      var who = holders.length ? '<small>' + h(holders.map(function (p) { return p.name; }).join('・')) + '</small>' : '<small>生存者なし</small>';
      var wordHtml = '';
      if (c.roleId === 'werewolf') {
        gv.log.filter(function (e) { return e.type === 'powerWordGiven' && e.day === gv.day && e.phase === 'night'; }).forEach(function (e) {
          var ids = Object.keys(e.data.words);
          wordHtml += '<div class="result word"><small>人狼に見せるパワーワード' + (e.data.shared ? '（全員共通）' : '（' + h(T.nameOf(gv, ids[0])) + '）') + '</small><b>' + h(e.data.words[ids[0]].text) + '</b><small>明日の昼に使わせる。見せたら画面を伏せる。</small></div>';
        });
      }
      var html = '<div class="card step"><h3>' + h(role(c.roleId).name) + who + '</h3><p class="say">「' + h(c.open) + '」</p>' + wordHtml;
      var opts = holders.length && c.actionId ? (gv.gmOptions[holders[0].id] || []).filter(function (a) { return a.actionId === c.actionId; })[0] : null;
      if (c.actionId && opts) {
        html += '<p class="say">「' + h(c.act) + '」</p>';
        var chosen = c.group ? groupChoice(gv, holders, c.actionId) : opts.chosen;
        var locked = chosen && RS.actions[c.actionId].changeable === false;
        if (locked) html += '<p class="big">' + h(T.nameOf(gv, chosen)) + '</p>';
        else html += targetButtons(gv, opts.targets, 'gmAct', chosen, 'data-role="' + c.roleId + '" data-act="' + c.actionId + '"');
        if (c.actionId === 'divine') {
          var res = gv.log.filter(function (e) { return e.type === 'divineResult' && e.day === gv.day && e.phase === 'night' && !e.data.oracle; }).pop();
          if (res) html += '<p class="result ' + (res.data.result === 'werewolf' ? 'wolf' : 'village') + '">結果：' + h(T.resultName(res.data.result)) + '</p>';
        }
      } else if (c.roleId === 'medium' && holders.length) {
        var m = gv.log.filter(function (e) { return e.type === 'mediumResult' && e.day === gv.day; }).pop();
        html += '<p class="say">「' + h(c.act) + '」</p>' + (m ? '<p class="result ' + (m.data.result === 'werewolf' ? 'wolf' : 'village') + '">' + h(T.formatEvent(m, gv, RS)) + '</p>' : '<p class="hint">今日の処刑はなかったので、示す結果はありません。</p>');
      } else if (c.roleId === 'seer' && holders.length) {
        var o = gv.log.filter(function (e) { return e.type === 'divineResult' && e.data.oracle && e.day === gv.day; }).pop();
        html += o ? '<p class="result village">' + h(T.formatEvent(o, gv, RS)) + '（その人を指差して伝える）</p>' : '<p class="hint">今夜は行動しません。台本だけ読んでください。</p>';
      } else {
        html += '<p class="hint">' + (holders.length ? '今夜は行動しません。' : '生存者がいません。') + '台本だけ読んで、少し間をあけてください。</p>';
      }
      html += '<p class="say">「' + h(c.close) + '」</p></div>';
      return html;
    }).join('');
    var pend = gv.pending.length;
    return header(gv) + '<div class="card script"><p>「' + h(T.script.nightStart) + '」</p></div>' + steps +
      gmPanel() +
      '<div class="card sticky">' + btn('朝にする', 'advance', pend ? 'disabled' : '', 'primary') +
      (pend ? '<p class="hint">まだ入力していない行動があります（' + pend + '件）</p>' : '') + '</div>';
  }
  function groupChoice(gv, holders, actionId) {
    var picks = holders.map(function (p) { return (gv.actions[p.id] || {})[actionId]; }).filter(Boolean);
    return picks.length === holders.length && picks.every(function (x) { return x === picks[0]; }) ? picks[0] : null;
  }

  // ---------------- メニュー ----------------
  function renderMenu() {
    return '<div class="overlay" data-action="closeMenu"><div class="sheet" data-stop="1">' +
      '<h3>メニュー</h3>' +
      btn('記録を見る（公開分）', 'showLog', '', 'ghost') +
      btn('ゲームをやめて最初の画面へ', 'quit', '', 'ghost danger') +
      btn('閉じる', 'closeMenu', '', '') + '</div></div>';
  }
  function renderLogOverlay() {
    return '<div class="overlay" data-action="closeMenu"><div class="sheet" data-stop="1"><h3>記録（全員に公開されたもの）</h3>' +
      logList(pubView()) + btn('閉じる', 'closeMenu', '', '') + '</div></div>';
  }

  // ---------------- 描画 ----------------
  var menuOpen = null;
  function render() {
    var html;
    if (app.screen === 'home') html = renderHome();
    else if (app.screen === 'rules') html = renderRules();
    else if (app.screen === 'setup') html = renderSetup();
    else html = renderGame();
    if (menuOpen === 'menu') html += renderMenu();
    if (menuOpen === 'log') html += renderLogOverlay();
    var root = $('#app');
    root.innerHTML = html;
    var pv = app.session && app.screen === 'game' ? pubView() : null;
    document.body.className = pv && (pv.phase === 'night' || pv.phase === 'reveal') && !app.announce ? 'is-night' : '';
  }

  // ---------------- 操作 ----------------
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.classList.contains('overlay') && e.target !== el) return;
    if (el.disabled) return;
    var a = el.getAttribute('data-action');
    var d = el.dataset;
    switch (a) {
      case 'home': app.screen = 'home'; break;
      case 'rules': app.screen = 'rules'; break;
      case 'new': initSetup(d.mode); app.screen = 'setup'; break;
      case 'resume': {
        var s = load(SAVE_KEY);
        app.mode = s.mode; app.ui = Object.assign({}, UI_DEFAULTS, s.ui || {});
        setRules(s.state.rulesetId);
        app.session = Session.createLocalSession(RS, s.state);
        app.flow = s.flow; app.announce = s.announce; app.screen = 'game';
        break;
      }
      case 'discard': if (confirm('途中のゲームを破棄しますか？')) drop(SAVE_KEY); break;
      case 'addPlayer': app.setup.names.push(''); syncCounts(); break;
      case 'removePlayer': app.setup.names.splice(+d.index, 1); syncCounts(); break;
      case 'auto': app.setup.auto = el.checked; syncCounts(); break;
      case 'count': {
        app.setup.auto = false;
        var c = app.setup.counts;
        c[d.role] = Math.max(0, (c[d.role] || 0) + (+d.delta));
        break;
      }
      case 'resetConfig': app.setup.config = Object.assign({}, RS.defaultConfig); app.ui = Object.assign({}, UI_DEFAULTS); break;
      case 'start': startGame(); return;
      case 'openPrivate': app.flow.stage = 'private'; app.pick = null; save(); break;
      case 'ackReveal':
        if (!send({ kind: 'player', playerId: d.player }, { type: 'ack', playerId: d.player })) return;
        nextInQueue(); break;
      case 'act':
        if (!send(as(d.player), { type: 'act', playerId: d.player, actionId: d.act, targetId: d.target })) return;
        break;
      case 'dummy': app.pick = d.target; break;
      case 'vote':
        if (!send(as(d.player), { type: 'vote', playerId: d.player, targetId: d.target })) return;
        break;
      case 'closePrivate': nextInQueue(); break;
      case 'restartQueue': app.flow.i = 0; app.flow.stage = 'handoff'; save(); break;
      case 'advance': advance(false, d.title); return;
      case 'submitVotes': submitVotes(d.title); return;
      case 'gmAct': {
        var gv = gmView();
        var holders = gv.players.filter(function (p) { return p.roleId === d.role && p.alive; });
        var group = T.nightCalls.some(function (c) { return c.roleId === d.role && c.group; });
        (group ? holders : holders.slice(0, 1)).forEach(function (p) {
          send({ kind: 'gm' }, { type: 'act', playerId: p.id, actionId: d.act, targetId: d.target });
        });
        break;
      }
      case 'peek': app.peek = { stage: 'pick' }; break;
      case 'peekPick': app.peek = { stage: 'show', pid: d.target }; break;
      case 'peekClose': app.peek = null; break;
      case 'closeAnnounce': app.announce = null; save(); break;
      case 'timerToggle': {
        var t = app.timer;
        if (t.running) { t.remaining = Math.max(0, Math.round((t.endAt - Date.now()) / 1000)); t.running = false; }
        else { if (t.remaining <= 0) t.remaining = app.session.view('public').config.discussionSeconds; t.endAt = Date.now() + t.remaining * 1000; t.running = true; }
        break;
      }
      case 'timerAdd': { var tt = app.timer; tt.remaining += 30; if (tt.running) tt.endAt += 30000; break; }
      case 'timerReset': app.timer.running = false; app.timer.remaining = pubView().config.discussionSeconds; break;
      case 'menu': menuOpen = 'menu'; break;
      case 'showLog': menuOpen = 'log'; break;
      case 'closeMenu': menuOpen = null; break;
      case 'quit':
        if (app.session && !app.session.view('public').result && !confirm('ゲームをやめますか？（途中経過は消えます）')) return;
        menuOpen = null; drop(SAVE_KEY); app.session = null; app.screen = 'home'; break;
      case 'again': {
        var mode = app.mode;
        menuOpen = null; drop(SAVE_KEY); app.session = null;
        initSetup(mode); app.screen = 'setup'; break;
      }
    }
    render();
  });

  function nextInQueue() {
    app.flow.i += 1;
    app.flow.stage = 'handoff';
    app.pick = null;
    save();
    window.scrollTo(0, 0);
  }

  document.addEventListener('input', function (e) {
    var el = e.target;
    if (el.classList.contains('name')) { app.setup.names[+el.dataset.index] = el.value; store(NAMES_KEY, app.setup.names); }
  });
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.dataset.rules) {
      var prev = app.setup.config;
      setRules(el.value);
      app.setup.rulesId = RS.id;
      var cfg = Object.assign({}, RS.defaultConfig);
      Object.keys(prev).forEach(function (k) { if (k in cfg) cfg[k] = prev[k]; });
      app.setup.config = cfg;
      syncCounts();
      render();
    } else if (el.dataset.config) {
      var val = JSON.parse(el.value);
      if (el.dataset.ui === '1') app.ui[el.dataset.config] = val; else app.setup.config[el.dataset.config] = val;
      render();
    } else if (el.dataset.vote) {
      if (el.value) app.gmVotes[el.dataset.vote] = el.value; else delete app.gmVotes[el.dataset.vote];
      render();
    }
  });

  render();
})();
