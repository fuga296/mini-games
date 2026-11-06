/* 63パズル — 4×4×4 の立体スライドパズル — solid/puzzle63/game.js */
(function () {
  'use strict';
  const T = THREE;
  const CONFIG = {
    n: 4,                 // 一辺のマス数(4 → 63パズル)
    shuffleMoves: 300,    // シャッフルで完成形から逆に動かす手数
    pieceSize: 0.84,      // ピースの大きさ(マス=1)
    offLineOpacity: 0.16, // 空きを通る3本の線の上にないピースの不透明度
    slideMs: 110,         // 1マス動くアニメーション時間
    swipeMinDot: 0.5      // スワイプ方向と軸の画面上の向きがこれ以上そろっていれば動かす(cos)
  };
  const $ = (id) => document.getElementById(id);
  const AX_COL = [0xff5a5a, 0x5ad35a, 0x5a9bff];   // X赤 Y緑 Z青(左下の軸表示と同じ)
  const LAYER_HUE = [8, 140, 215, 45];              // 完成時の Z 層ごとの色

  let n, NN, grid, empty, moves, t0, tEnd, solvedFlag, playing;
  const viewer = Solid.createViewer($('stage'), {
    onTap: (x, y) => { const pos = pickPiece(x, y); if (pos >= 0) slidePiece(pos); },
    // ピースの上で始めたドラッグでも、空きへ向かう向きに動かしたときだけスワイプ(=スライド)。それ以外は盤面の回転
    claimDrag: (x, y, i, dx, dy) => { dragPos = pickPiece(x, y); if (dragPos < 0) return false; if (!slideDirOK(dragPos, dx, -dy)) { dragPos = -1; return false; } return true; },
    onClaimedDragEnd: (dx, dy, x, y, cancelled) => { if (!cancelled) swipePiece(dragPos, dx, -dy); dragPos = -1; }
  });
  let dragPos = -1;
  const board = viewer.board;
  const bottom = $('bottom');
  const lf = new Solid.LayerFrame(board);
  const layer = Solid.createLayerControl(bottom, { dims: [4, 4, 4], axis: 2, onChange: () => { lf.update([n, n, n], layer.state); refresh(); } });
  Solid.createRotatePad($('stage'), viewer); // 回転・拡大は盤面の上のパッド(下のパネルは層と操作だけ)

  let meshes = [], lines = [], emptyBox = null;
  const geo = new T.BoxGeometry(1, 1, 1);

  function pieceTexture(k, hue) {
    return Solid.textTexture(String(k), '#ffffff', { bg: 'hsl(' + hue + ',55%,42%)', border: 'hsl(' + hue + ',60%,72%)', scale: 0.56 });
  }
  const P = (pos) => [pos % n, ((pos / n) | 0) % n, (pos / (n * n)) | 0];
  const I = (x, y, z) => x + n * (y + n * z);

  function build() {
    n = CONFIG.n; NN = n * n * n;
    for (const m of meshes) if (m) { board.remove(m); m.material.map.dispose(); m.material.dispose(); }
    for (const l of lines) board.remove(l);
    if (emptyBox) board.remove(emptyBox);
    meshes = [null];
    for (let k = 1; k < NN; k++) {
      const [, , z] = P(k - 1);
      const mat = new T.MeshLambertMaterial({ map: pieceTexture(k, LAYER_HUE[z % 4] + (k % 2) * 6), transparent: true });
      const m = new T.Mesh(geo, mat); m.userData.k = k; m.scale.setScalar(CONFIG.pieceSize);
      board.add(m); meshes.push(m);
    }
    lines = [0, 1, 2].map((a) => {
      const s = [0.05, 0.05, 0.05]; s[a] = n;
      const m = new T.Mesh(new T.BoxGeometry(s[0], s[1], s[2]), new T.MeshBasicMaterial({ color: AX_COL[a], transparent: true, opacity: 0.9, depthTest: false }));
      m.renderOrder = 10; board.add(m); return m;
    });
    emptyBox = new T.LineSegments(new T.EdgesGeometry(geo), new T.LineBasicMaterial({ color: 0xffd25a, depthTest: false }));
    emptyBox.renderOrder = 11; emptyBox.scale.setScalar(CONFIG.pieceSize); board.add(emptyBox);
    layer.setDims([n, n, n]); lf.update([n, n, n], layer.state);
    viewer.setBounds(new T.Vector3(n, n, n)); viewer.reset(false);
    solved();
  }
  function solved() {
    grid = new Int16Array(NN); for (let i = 0; i < NN - 1; i++) grid[i] = i + 1; grid[NN - 1] = 0; empty = NN - 1;
    moves = 0; t0 = tEnd = 0; playing = false; solvedFlag = true;
    for (let i = 0; i < NN - 1; i++) place(grid[i], i, true);
    refresh(); status();
  }
  function place(k, pos, instant) {
    const m = meshes[k], [x, y, z] = P(pos);
    m.userData.to = new T.Vector3(x + 0.5, y + 0.5, z + 0.5);
    if (instant) m.position.copy(m.userData.to); else animate();
  }
  let animating = false;
  function animate() {
    if (animating) return; animating = true;
    viewer.addTick((dt) => {
      let busy = false; const step = dt * 1000 / CONFIG.slideMs;
      for (let k = 1; k < NN; k++) {
        const m = meshes[k], to = m.userData.to, d = m.position.distanceTo(to);
        if (d > 1e-4) { busy = true; if (d <= step) m.position.copy(to); else m.position.lerp(to, step / d); }
      }
      if (!busy) animating = false; return busy;
    });
  }
  const onLine = (pos) => { if (pos === empty) return false; const a = P(pos), e = P(empty); let s = 0; for (let i = 0; i < 3; i++) if (a[i] === e[i]) s++; return s === 2; };

  /* 見た目の更新: 3本の線上のピースを強調し、それ以外は半透明 */
  function refresh() {
    const e = P(empty);
    for (let pos = 0; pos < NN; pos++) {
      const k = grid[pos]; if (!k) continue;
      const m = meshes[k], [x, y, z] = P(pos), v = layer.vis(x, y, z);
      m.visible = v > 0;
      const hl = onLine(pos);
      m.material.opacity = v === 1 ? 0.12 : hl ? 1 : CONFIG.offLineOpacity;
      m.material.depthWrite = m.material.opacity === 1;
      m.material.emissive.setHex(hl ? 0x2a2a2a : 0x000000);
      m.renderOrder = hl ? 1 : 0;
    }
    for (let a = 0; a < 3; a++) { const p = [e[0] + 0.5, e[1] + 0.5, e[2] + 0.5]; p[a] = n / 2; lines[a].position.set(p[0], p[1], p[2]); }
    emptyBox.position.set(e[0] + 0.5, e[1] + 0.5, e[2] + 0.5);
    $('info').textContent = '空き (' + (e[0] + 1) + ',' + (e[1] + 1) + ',' + (e[2] + 1) + ')';
    viewer.render();
  }

  /* ---- 動かす ---- */
  function moveOne(from) { // from は空きの隣。そのピースを空きへ
    const k = grid[from]; grid[empty] = k; grid[from] = 0;
    if (k) place(k, empty, shuffling); empty = from;
  }
  let shuffling = false;
  function slidePiece(pos) {
    if (!onLine(pos)) { toast('空きを通る線の上のピースだけ動かせます'); return; }
    const a = P(pos), e = P(empty);
    let ax = 0; for (let i = 0; i < 3; i++) if (a[i] !== e[i]) ax = i;
    const s = Math.sign(a[ax] - e[ax]);
    while (empty !== pos) { const c = P(empty); c[ax] += s; moveOne(I(c[0], c[1], c[2])); afterMove(); }
    refresh(); status(); checkWin();
  }
  function afterMove() { moves++; if (!t0) t0 = performance.now(); playing = true; solvedFlag = false; }

  // 画面上の方向 (sx 右, sy 上) へ1マス動かす。その方向に最も近い盤面の軸を、いまの向きから選ぶ
  function slideScreen(sx, sy) {
    let best = null, bd = -2;
    for (let a = 0; a < 3; a++) for (const s of [1, -1]) {
      const v = new T.Vector3(); v.setComponent(a, s);
      const w = viewer.axisOnScreen(v); const L = Math.hypot(w.x, w.y); if (L < 1e-6) continue;
      const d = (w.x * sx + w.y * sy) / Math.hypot(sx, sy);
      if (d > bd) { bd = d; best = { a, s }; }
    }
    if (!best || bd < CONFIG.swipeMinDot) { toast('その向きの軸は奥行き方向です。回転してください'); return; }
    const c = P(empty); c[best.a] -= best.s; // 空きの「反対側」にあるピースが、その方向へ動いて空きに入る
    if (c[best.a] < 0 || c[best.a] >= n) { toast('その方向には動かせません'); return; }
    slidePiece(I(c[0], c[1], c[2]));
  }
  function slideDirOK(pos, sx, sy) { // pos のピースを空きへ動かす向きが、画面上で (sx,sy) とそろっているか
    if (!onLine(pos) || Math.hypot(sx, sy) < 1) return false;
    const a = P(pos), e = P(empty); let ax = 0; for (let i = 0; i < 3; i++) if (a[i] !== e[i]) ax = i;
    const v = new T.Vector3(); v.setComponent(ax, Math.sign(e[ax] - a[ax]));
    const w = viewer.axisOnScreen(v), L = Math.hypot(w.x, w.y);
    return L > 0.2 && (w.x * sx + w.y * sy) / (L * Math.hypot(sx, sy)) > CONFIG.swipeMinDot;
  }
  function swipePiece(pos, sx, sy) {
    if (pos < 0 || Math.hypot(sx, sy) < 1) return;
    if (!onLine(pos)) { toast('空きを通る線の上のピースだけ動かせます'); return; }
    const a = P(pos), e = P(empty); let ax = 0; for (let i = 0; i < 3; i++) if (a[i] !== e[i]) ax = i;
    const v = new T.Vector3(); v.setComponent(ax, Math.sign(e[ax] - a[ax]));
    const w = viewer.axisOnScreen(v), L = Math.hypot(w.x, w.y);
    if (L > 0.2 && (w.x * sx + w.y * sy) / (L * Math.hypot(sx, sy)) > CONFIG.swipeMinDot) slidePiece(pos);
    else toast('空きの方向へスワイプしてください');
  }
  function pickPiece(x, y) {
    const rc = viewer.raycaster(x, y);
    const cand = [];
    for (let pos = 0; pos < NN; pos++) { const k = grid[pos]; if (k && onLine(pos) && meshes[k].visible && meshes[k].material.opacity > 0.5) cand.push(meshes[k]); }
    const hit = rc.intersectObjects(cand, false)[0];
    if (!hit) return -1;
    const k = hit.object.userData.k; for (let pos = 0; pos < NN; pos++) if (grid[pos] === k) return pos;
    return -1;
  }

  function shuffle() {
    solved();
    shuffling = true;
    let last = -1;
    for (let i = 0; i < CONFIG.shuffleMoves; i++) {
      const e = P(empty), opts = [];
      for (let a = 0; a < 3; a++) for (const s of [1, -1]) {
        const c = e.slice(); c[a] += s; if (c[a] < 0 || c[a] >= n) continue;
        const p = I(c[0], c[1], c[2]); if (p !== last) opts.push(p); // 直前の逆戻りはしない
      }
      const p = opts[Math.floor(Math.random() * opts.length)]; last = empty; moveOne(p);
    }
    shuffling = false;
    for (let pos = 0; pos < NN; pos++) if (grid[pos]) place(grid[pos], pos, true);
    moves = 0; t0 = 0; playing = true; solvedFlag = isSolved();
    refresh(); status();
  }
  const isSolved = () => { for (let i = 0; i < NN - 1; i++) if (grid[i] !== i + 1) return false; return grid[NN - 1] === 0; };
  function checkWin() {
    if (playing && isSolved()) {
      playing = false; solvedFlag = true; tEnd = performance.now();
      setTimeout(() => Solid.dialog('<h2>🎉 完成!</h2><p>' + moves + ' 手 / ' + Solid.formatTime((tEnd - t0) / 1000) + '</p>', [['閉じる'], ['もう一度シャッフル', shuffle]]), 250);
    }
  }

  /* ---- 表示 ---- */
  function status() {
    $('moves').textContent = moves + ' 手';
    const t = t0 ? ((tEnd || performance.now()) - t0) / 1000 : 0;
    $('time').textContent = '⏱ ' + Solid.formatTime(t);
  }
  setInterval(status, 250);
  let tt = 0;
  function toast(s) { const e = $('toast'); e.textContent = s; e.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => e.classList.remove('show'), 1600); }

  document.querySelectorAll('[data-dir]').forEach((b) => { const [x, y] = b.dataset.dir.split(',').map(Number); b.onclick = () => slideScreen(x, y); });
  $('shuffle').onclick = shuffle;
  Solid.bindCommonKeys(viewer, layer, (e) => {
    const m = { arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0], arrowup: [0, 1], w: [0, 1], arrowdown: [0, -1], s: [0, -1] }[e.key.toLowerCase()];
    if (m) { slideScreen(m[0], m[1]); return true; }
  });
  $('help').onclick = () => Solid.dialog(`<h2>遊び方</h2>
    <ul><li>4×4×4 に 1〜63 のピースと空きが1つ。完成形は 1 が左下手前…63 が右上奥、空きが最後の角。</li>
    <li>動かせるのは、<b>空きを通る3本の線</b>(赤=X・緑=Y・青=Z)の上のピースだけ。それ以外は半透明になっています。</li>
    <li><b>矢印ボタン/矢印キー/WASD</b>: 画面のその方向へ、空きの隣のピースを1つスライド。どの軸が動くかは今の向きで決まります。</li>
    <li>奥行き方向(画面に垂直)へ動かしたいときは、<b>回転</b>して その軸を画面の上下左右に向けてください。</li>
    <li>線上のピースを<b>タップ</b>すると、そのピースと間のピースがまとめて空きの方へ動きます(1マス=1手)。線上のピースを空きの方へ<b>スワイプ</b>しても動きます。</li>
    <li>ピースのない所をドラッグ: 回転。ピンチ/ホイール: 拡大縮小。2本指/右ドラッグ: 移動。</li>
    <li><b>層</b>: 単層・ここまで で内部を見る。完成時の Z 層ごとに色が違います。</li></ul>
    <p>キー: <kbd>I</kbd><kbd>K</kbd> X軸 / <kbd>J</kbd><kbd>L</kbd> Y軸 / <kbd>U</kbd><kbd>O</kbd> Z軸 / <kbd>P</kbd> 軸にそろえる / <kbd>[</kbd><kbd>]</kbd> 層</p>`);
  $('settings').onclick = () => Solid.dialog(`<h2>設定</h2>
    <label>シャッフル手数 <input type="number" id="sm" min="1" max="5000" value="${CONFIG.shuffleMoves}"></label><br>
    <label>ピースの大きさ <input type="number" id="ps" min="0.4" max="1" step="0.02" value="${CONFIG.pieceSize}"></label><br>
    <label>線の外のピースの不透明度 <input type="number" id="op" min="0" max="1" step="0.05" value="${CONFIG.offLineOpacity}"></label><br>
    <label>一辺 <input type="number" id="nn" min="2" max="6" value="${CONFIG.n}"></label> <span style="color:var(--sub)">(4 で 63パズル)</span>`,
    [['キャンセル'], ['適用', () => {
      const v = (id) => +document.getElementById(id).value;
      CONFIG.shuffleMoves = Math.max(1, Math.min(5000, Math.round(v('sm')) || 300));
      CONFIG.pieceSize = Math.max(0.4, Math.min(1, v('ps') || 0.84));
      CONFIG.offLineOpacity = Math.max(0, Math.min(1, isNaN(v('op')) ? 0.16 : v('op')));
      const nn = Math.max(2, Math.min(6, Math.round(v('nn')) || 4));
      if (nn !== CONFIG.n) { CONFIG.n = nn; build(); shuffle(); }
      else { for (let k = 1; k < NN; k++) meshes[k].scale.setScalar(CONFIG.pieceSize); emptyBox.scale.setScalar(CONFIG.pieceSize); refresh(); }
    }]]);

  build();
  shuffle();
  window.__p63 = { get grid() { return grid; }, get empty() { return empty; }, get moves() { return moves; }, slideScreen, slidePiece, shuffle, solved, isSolved, viewer, layer, CONFIG };
})();
