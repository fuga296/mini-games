/* 立体マインスイーパー — solid/minesweeper/game.js */
(function () {
  'use strict';
  const T = THREE;

  /* ---- 難易度と地雷数(提案値。下の CONFIG / 設定画面で変更できる) ----
   * 26方向の隣接では、地雷密度 p のとき「周囲の地雷の期待値」は 26p。
   * 平面(8方向)の 初級12% / 中級16% / 上級21% だと 3.2〜5.4 になり数字が大きすぎる。
   * 平面の期待値(初級0.99 / 中級1.25 / 上級1.65)に合わせ、5.6〜8.1% にした。
   * 端のマスは隣が少ないので、実測の平均は 0.93 / 1.29 / 1.70 / 1.94(各20回の試算)。 */
  const LEVELS = [
    { id: 'easy',   name: '初級 5×5×5',      d: [5, 5, 5],    mines: 7 },    // 5.6%
    { id: 'normal', name: '中級 16×16×5',    d: [16, 16, 5],  mines: 80 },   // 6.3%
    { id: 'hard',   name: '上級 16×30×10',   d: [16, 30, 10], mines: 360 },  // 7.5%
    { id: 'expert', name: '超上級 24×48×16', d: [24, 48, 16], mines: 1500 }  // 8.1%
  ];
  const CONFIG = {
    cubeSize: 0.82,     // マスの見た目の大きさ(1=隙間なし)。隙間で奥の様子が少し見える
    numberSize: 0.72,   // 数字の大きさ(マス=1)
    ghostOpacity: 0.13, // 「前後を薄く」で表示する層の不透明度
    safeArea: 'neighbors' // 最初のクリック: 'neighbors'=周囲26マスも安全(必ず開く) / 'cell'=そのマスだけ安全
  };
  const HIDDEN = 0, OPEN = 1, FLAG = 2;

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  let level = LEVELS[0], custom = { d: [8, 8, 8], mines: 30 };
  let nx, ny, nz, N, mine, count, state, first, over, won, flags, opened, boom, t0, tEnd;
  let hover = -1, selected = -1, flagMode = false;

  /* ---- 表示 ---- */
  const viewer = Solid.createViewer(stage, {
    onTap: (x, y, i) => act(pick(x, y), i.button === 2 ? 'flag' : flagMode ? 'flag' : 'open'),
    onLongPress: (x, y) => act(pick(x, y), flagMode ? 'open' : 'flag'),
    onHover: (x, y) => { const p = pick(x, y); setHover(p ? p.i : -1); }
  });
  viewer.canvas.addEventListener('pointerleave', () => setHover(-1));
  const board = viewer.board;
  const lf = new Solid.LayerFrame(board);
  const bottom = $('bottom');
  const layer = Solid.createLayerControl(bottom, { dims: [5, 5, 5], axis: 2, onChange: () => { lf.update([nx, ny, nz], layer.state); rebuild(); } });
  Solid.createRotateControls(bottom, viewer);

  const boxGeo = new T.BoxGeometry(1, 1, 1);
  let cubes = null, ghosts = null;
  const cubeMat = new T.MeshLambertMaterial({ color: 0xffffff });
  const ghostMat = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: CONFIG.ghostOpacity, depthWrite: false });

  // 数字: 常に画面を向く点スプライト。数字ごとの画像をまとめたアトラスを1枚使う
  const atlas = makeAtlas();
  const numMat = new T.ShaderMaterial({
    uniforms: { uAtlas: { value: atlas }, uScale: { value: 100 } },
    transparent: true,
    vertexShader: `attribute float num; attribute float alpha; uniform float uScale; varying float vNum; varying float vA;
      void main(){ vNum=num; vA=alpha; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv; gl_PointSize=uScale/-mv.z; }`,
    fragmentShader: `uniform sampler2D uAtlas; varying float vNum; varying float vA;
      void main(){ float k=floor(vNum+0.5); float c=mod(k,8.0); float r=floor(k/8.0);
        vec2 uv=vec2((c+gl_PointCoord.x)/8.0, 1.0-(r+gl_PointCoord.y)/4.0);
        vec4 t=texture2D(uAtlas,uv); if(t.a<0.4) discard; gl_FragColor=vec4(t.rgb, vA); }`
  });
  let points = null;
  viewer.onResize = (w, h) => {
    const pr = viewer.renderer.getPixelRatio();
    numMat.uniforms.uScale.value = CONFIG.numberSize * h * pr / (2 * Math.tan(T.MathUtils.degToRad(viewer.camera.fov) / 2));
  };
  viewer.onResize(viewer.size().w, viewer.size().h);

  // マウスを乗せた/選んだマスと、その周囲26マス(3×3×3)の枠
  const cellFrame = new T.LineSegments(new T.EdgesGeometry(boxGeo), new T.LineBasicMaterial({ color: 0xffffff }));
  const nbFrame = new T.LineSegments(new T.EdgesGeometry(boxGeo), new T.LineBasicMaterial({ color: 0x7fe0ff, transparent: true, opacity: 0.9 }));
  cellFrame.visible = nbFrame.visible = false; board.add(cellFrame); board.add(nbFrame);

  function makeAtlas() {
    const s = 64, c = document.createElement('canvas'); c.width = s * 8; c.height = s * 4;
    const g = c.getContext('2d'); g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let k = 1; k <= 28; k++) {
      const cx = (k % 8) * s + s / 2, cy = Math.floor(k / 8) * s + s / 2;
      if (k === 27) { // 地雷
        g.fillStyle = '#111'; g.strokeStyle = '#ff5050'; g.lineWidth = 4;
        g.beginPath(); g.arc(cx, cy, s * 0.28, 0, 7); g.fill(); g.stroke(); continue;
      }
      if (k === 28) { // 間違った旗
        g.strokeStyle = '#ff5050'; g.lineWidth = 8; g.beginPath();
        g.moveTo(cx - 18, cy - 18); g.lineTo(cx + 18, cy + 18); g.moveTo(cx + 18, cy - 18); g.lineTo(cx - 18, cy + 18); g.stroke(); continue;
      }
      g.font = 'bold ' + (k >= 10 ? 40 : 50) + 'px system-ui, sans-serif';
      g.lineWidth = 9; g.strokeStyle = 'rgba(0,0,0,0.9)'; g.strokeText(String(k), cx, cy + 2);
      g.fillStyle = 'hsl(' + ((215 - (k - 1) * 22 + 360) % 360) + ',95%,' + (k === 1 ? 72 : 64) + '%)';
      g.fillText(String(k), cx, cy + 2);
    }
    const t = new T.CanvasTexture(c); t.minFilter = T.LinearMipmapLinearFilter; return t;
  }

  /* ---- 盤面 ---- */
  const idx = (x, y, z) => x + nx * (y + ny * z);
  const X = (i) => i % nx, Y = (i) => ((i / nx) | 0) % ny, Z = (i) => (i / (nx * ny)) | 0;
  function forNb(i, f) {
    const x = X(i), y = Y(i), z = Z(i);
    for (let dz = -1; dz <= 1; dz++) { const zz = z + dz; if (zz < 0 || zz >= nz) continue;
      for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= ny) continue;
        for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= nx || (!dx && !dy && !dz)) continue; f(idx(xx, yy, zz)); } } }
  }
  function curDef() { return level.id === 'custom' ? custom : level; }

  function newGame() {
    const def = curDef();
    [nx, ny, nz] = def.d; N = nx * ny * nz;
    const M = Math.min(def.mines, N - 1);
    mine = new Uint8Array(N); count = new Uint8Array(N); state = new Uint8Array(N);
    first = true; over = false; won = false; flags = 0; opened = 0; boom = -1; t0 = 0; tEnd = 0;
    hover = selected = -1; mineTotal = M;
    if (cubes) { board.remove(cubes); board.remove(ghosts); board.remove(points); cubes.dispose(); ghosts.dispose(); points.geometry.dispose(); }
    cubes = new T.InstancedMesh(boxGeo, cubeMat, N); ghosts = new T.InstancedMesh(boxGeo, ghostMat, N);
    for (const m of [cubes, ghosts]) { m.setColorAt(0, new T.Color()); m.frustumCulled = false; m.instanceMatrix.setUsage(T.DynamicDrawUsage); board.add(m); }
    const pg = new T.BufferGeometry();
    pg.setAttribute('position', new T.BufferAttribute(new Float32Array(N * 3), 3));
    pg.setAttribute('num', new T.BufferAttribute(new Float32Array(N), 1));
    pg.setAttribute('alpha', new T.BufferAttribute(new Float32Array(N), 1));
    points = new T.Points(pg, numMat); points.frustumCulled = false; board.add(points);
    layer.setDims([nx, ny, nz]); lf.update([nx, ny, nz], layer.state);
    viewer.setBounds(new T.Vector3(nx, ny, nz)); viewer.reset(false);
    rebuild(); status();
  }
  let mineTotal = 0;

  function placeMines(safe) {
    const excl = new Uint8Array(N); excl[safe] = 1;
    if (CONFIG.safeArea === 'neighbors') { let n = 0; forNb(safe, () => n++); if (N - n - 1 >= mineTotal) forNb(safe, (j) => { excl[j] = 1; }); }
    const cand = []; for (let i = 0; i < N; i++) if (!excl[i]) cand.push(i);
    for (let k = 0; k < mineTotal; k++) { const r = k + Math.floor(Math.random() * (cand.length - k)); const t = cand[k]; cand[k] = cand[r]; cand[r] = t; mine[cand[k]] = 1; }
    for (let i = 0; i < N; i++) if (mine[i]) forNb(i, (j) => { count[j]++; });
  }

  function reveal(i) {
    if (first) { placeMines(i); first = false; t0 = performance.now(); }
    if (state[i] !== HIDDEN) return;
    if (mine[i]) { lose(i); return; }
    const st = [i];
    while (st.length) {
      const j = st.pop(); if (state[j] !== HIDDEN) continue;
      state[j] = OPEN; opened++;
      if (count[j] === 0) forNb(j, (k) => { if (state[k] === HIDDEN && !mine[k]) st.push(k); });
    }
    if (opened === N - mineTotal) win();
  }
  function chord(i) {
    let f = 0; forNb(i, (j) => { if (state[j] === FLAG) f++; });
    if (f !== count[i]) { toast('周りの旗が ' + f + ' 本(数字は ' + count[i] + ')'); return; }
    forNb(i, (j) => { if (!over && state[j] === HIDDEN) reveal(j); });
  }
  function toggleFlag(i) {
    if (state[i] === HIDDEN) { state[i] = FLAG; flags++; } else if (state[i] === FLAG) { state[i] = HIDDEN; flags--; }
  }
  function lose(i) { over = true; boom = i; tEnd = performance.now(); setTimeout(() => Solid.dialog('<h2>💥 地雷を開けました</h2><p>赤いマスが地雷、紫は間違った旗です。</p>', [['盤面を見る'], ['もう一度', newGame]]), 400); }
  function win() {
    over = won = true; tEnd = performance.now();
    for (let i = 0; i < N; i++) if (mine[i] && state[i] !== FLAG) { state[i] = FLAG; flags++; }
    setTimeout(() => Solid.dialog('<h2>🎉 クリア!</h2><p>' + level.name + ' — ' + Solid.formatTime((tEnd - t0) / 1000) + '</p>', [['盤面を見る'], ['もう一度', newGame]]), 300);
  }

  function act(p, kind) {
    if (!p || over) { selected = -1; rebuild(); return; }
    const i = p.i;
    if (p.kind === 'num') chord(i);
    else if (kind === 'flag') toggleFlag(i);
    else if (state[i] === HIDDEN) reveal(i);
    selected = state[i] === OPEN && count[i] > 0 ? i : -1;
    rebuild(); status();
  }
  function setHover(i) { if (i !== hover) { hover = i; rebuild(); } }

  /* ---- 視線とマスの交差(格子をたどる DDA。全マスを調べないので超上級でも軽い) ---- */
  function pick(sx, sy) {
    if (!state) return null;
    const ray = viewer.localRay(sx, sy), o = ray.origin, d = ray.direction;
    const O = [o.x, o.y, o.z], D = [d.x, d.y, d.z], S = [nx, ny, nz];
    let tmin = 0, tmax = Infinity;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(D[a]) < 1e-12) { if (O[a] < 0 || O[a] > S[a]) return null; continue; }
      const t1 = (0 - O[a]) / D[a], t2 = (S[a] - O[a]) / D[a];
      tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
    }
    if (tmin > tmax) return null;
    const c = [], step = [], tNext = [], tDel = [];
    for (let a = 0; a < 3; a++) {
      c[a] = Math.min(S[a] - 1, Math.max(0, Math.floor(O[a] + D[a] * (tmin + 1e-7))));
      step[a] = D[a] > 0 ? 1 : -1;
      tDel[a] = Math.abs(D[a]) < 1e-12 ? Infinity : Math.abs(1 / D[a]);
      tNext[a] = Math.abs(D[a]) < 1e-12 ? Infinity : ((D[a] > 0 ? c[a] + 1 : c[a]) - O[a]) / D[a];
    }
    for (let guard = 0; guard < nx + ny + nz + 3; guard++) {
      const v = layer.vis(c[0], c[1], c[2]);
      if (v === 2) {
        const i = idx(c[0], c[1], c[2]);
        if (state[i] !== OPEN) return { i, kind: 'cell' };
        if (count[i] > 0 && !mine[i]) { // 数字は中心付近だけを当たりにして、奥のマスにも触れるようにする
          const cx = c[0] + 0.5 - O[0], cy = c[1] + 0.5 - O[1], cz = c[2] + 0.5 - O[2];
          const t = cx * D[0] + cy * D[1] + cz * D[2];
          const dd = (cx - D[0] * t) ** 2 + (cy - D[1] * t) ** 2 + (cz - D[2] * t) ** 2;
          if (dd < (CONFIG.numberSize * 0.45) ** 2) return { i, kind: 'num' };
        }
      }
      let a = tNext[0] < tNext[1] ? (tNext[0] < tNext[2] ? 0 : 2) : (tNext[1] < tNext[2] ? 1 : 2);
      if (tNext[a] > tmax) break;
      c[a] += step[a]; if (c[a] < 0 || c[a] >= S[a]) break;
      tNext[a] += tDel[a];
    }
    return null;
  }

  /* ---- 描画データの作り直し(見えるマスだけを詰めて送る) ---- */
  const col = new T.Color();
  const C_BASE = [new T.Color(0x6d84b4), new T.Color(0x7d93c2)], C_HOV = new T.Color(0xc8d6ff), C_FLAG = new T.Color(0xff9a3c),
    C_MINE = new T.Color(0xd23a3a), C_BOOM = new T.Color(0xff2020), C_WRONG = new T.Color(0x9a4ad8), C_GHOST = new T.Color(0x9fb4e0);
  function rebuild() {
    if (!cubes) return;
    const cm = cubes.instanceMatrix.array, cc = cubes.instanceColor.array, gm = ghosts.instanceMatrix.array, gc = ghosts.instanceColor.array;
    const pp = points.geometry.attributes.position.array, pn = points.geometry.attributes.num.array, pa = points.geometry.attributes.alpha.array;
    let c = 0, g = 0, p = 0;
    const s = CONFIG.cubeSize;
    const solid = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && state[idx(x, y, z)] !== OPEN && layer.vis(x, y, z) === 2;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const v = layer.vis(x, y, z); if (!v) continue;
      const i = idx(x, y, z), stt = state[i];
      const showMine = over && mine[i];
      if (stt !== OPEN) {
        if (v === 2) {
          // 6面すべてが他のマスで隠れているマスは描かない(見た目は同じで描画が軽くなる)
          if (i !== hover && solid(x - 1, y, z) && solid(x + 1, y, z) && solid(x, y - 1, z) && solid(x, y + 1, z) && solid(x, y, z - 1) && solid(x, y, z + 1)) continue;
          if (i === hover && !over) col.copy(C_HOV);
          else if (stt === FLAG) col.copy(over && !mine[i] ? C_WRONG : C_FLAG);
          else if (showMine) col.copy(i === boom ? C_BOOM : C_MINE);
          else col.copy(C_BASE[(x + y + z) & 1]);
          const k = c * 16, sc = i === boom ? s * 1.12 : s;
          cm[k] = sc; cm[k + 1] = 0; cm[k + 2] = 0; cm[k + 3] = 0; cm[k + 4] = 0; cm[k + 5] = sc; cm[k + 6] = 0; cm[k + 7] = 0;
          cm[k + 8] = 0; cm[k + 9] = 0; cm[k + 10] = sc; cm[k + 11] = 0; cm[k + 12] = x + 0.5; cm[k + 13] = y + 0.5; cm[k + 14] = z + 0.5; cm[k + 15] = 1;
          cc[c * 3] = col.r; cc[c * 3 + 1] = col.g; cc[c * 3 + 2] = col.b; c++;
        } else {
          col.copy(showMine ? C_MINE : stt === FLAG ? C_FLAG : C_GHOST);
          const k = g * 16;
          gm[k] = s; gm[k + 1] = 0; gm[k + 2] = 0; gm[k + 3] = 0; gm[k + 4] = 0; gm[k + 5] = s; gm[k + 6] = 0; gm[k + 7] = 0;
          gm[k + 8] = 0; gm[k + 9] = 0; gm[k + 10] = s; gm[k + 11] = 0; gm[k + 12] = x + 0.5; gm[k + 13] = y + 0.5; gm[k + 14] = z + 0.5; gm[k + 15] = 1;
          gc[g * 3] = col.r; gc[g * 3 + 1] = col.g; gc[g * 3 + 2] = col.b; g++;
        }
      } else if (count[i] > 0) {
        pp[p * 3] = x + 0.5; pp[p * 3 + 1] = y + 0.5; pp[p * 3 + 2] = z + 0.5;
        pn[p] = count[i]; pa[p] = v === 2 ? 1 : 0.35; p++;
      }
    }
    cubes.count = c; ghosts.count = g;
    cubes.instanceMatrix.needsUpdate = cubes.instanceColor.needsUpdate = true;
    ghosts.instanceMatrix.needsUpdate = ghosts.instanceColor.needsUpdate = true;
    const ga = points.geometry.attributes; ga.position.needsUpdate = ga.num.needsUpdate = ga.alpha.needsUpdate = true;
    points.geometry.setDrawRange(0, p);

    // 枠: 対象マスと周囲26マス(開いて消えた 0 のマスは対象外)
    if (hover >= 0 && (hover >= N || (state[hover] === OPEN && count[hover] === 0))) hover = -1;
    const f = hover >= 0 ? hover : selected;
    if (f >= 0 && f < N) {
      const x = X(f), y = Y(f), z = Z(f);
      cellFrame.visible = true; cellFrame.position.set(x + 0.5, y + 0.5, z + 0.5); cellFrame.scale.setScalar(1.0);
      const lo = [Math.max(0, x - 1), Math.max(0, y - 1), Math.max(0, z - 1)], hi = [Math.min(nx, x + 2), Math.min(ny, y + 2), Math.min(nz, z + 2)];
      nbFrame.visible = state[f] === OPEN;
      nbFrame.position.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
      nbFrame.scale.set(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      const nf = (() => { let n = 0; forNb(f, (j) => { if (state[j] === FLAG) n++; }); return n; })();
      $('info').textContent = '(' + (x + 1) + ',' + (y + 1) + ',' + (z + 1) + ')' + (state[f] === OPEN ? ' 数字 ' + count[f] + ' / 旗 ' + nf : '');
    } else { cellFrame.visible = nbFrame.visible = false; $('info').textContent = '開いた ' + opened + ' / ' + (N - mineTotal); }
    viewer.render();
  }

  /* ---- 状態表示 ---- */
  function status() {
    $('mines').textContent = '💣 ' + (mineTotal - flags);
    const t = t0 ? ((over ? tEnd : performance.now()) - t0) / 1000 : 0;
    $('time').textContent = '⏱ ' + Solid.formatTime(t);
  }
  setInterval(status, 250);
  let toastTimer = 0;
  function toast(s) { const e = $('toast'); e.textContent = s; e.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => e.classList.remove('show'), 1500); }

  /* ---- UI ---- */
  const lv = $('level');
  function fillLevels() {
    lv.innerHTML = '';
    for (const L of LEVELS) { const o = document.createElement('option'); o.value = L.id; o.textContent = L.name; lv.appendChild(o); }
    const o = document.createElement('option'); o.value = 'custom'; o.textContent = 'カスタム ' + custom.d.join('×'); lv.appendChild(o);
    lv.value = level.id;
  }
  lv.onchange = () => { level = LEVELS.find((L) => L.id === lv.value) || { id: 'custom', name: 'カスタム' }; newGame(); };
  $('newgame').onclick = newGame;
  function setFlagMode(f) { flagMode = f; $('modeOpen').classList.toggle('on', !f); $('modeFlag').classList.toggle('on', f); }
  $('modeOpen').onclick = () => setFlagMode(false);
  $('modeFlag').onclick = () => setFlagMode(true);
  $('help').onclick = () => Solid.dialog(`<h2>遊び方</h2>
    <ul><li>数字は、そのマスを囲む <b>26マス</b>(3×3×3 から自分を除く)にある地雷の数。</li>
    <li>最初に開くマスと、その周り26マスには地雷がありません。</li>
    <li><b>タップ/クリック</b>: 開く(🚩モードでは旗)。<b>長押し/右クリック</b>: 旗(🚩モードでは開く)。</li>
    <li>数字をタップ: 周りの旗の数が数字と同じなら、残りの周りのマスをまとめて開く。</li>
    <li><b>ドラッグ</b>: 盤面を回す。<b>ピンチ/ホイール</b>: 拡大縮小。<b>2本指/右ドラッグ/Shift+ドラッグ</b>: 移動。</li>
    <li><b>層</b>: 「単層」で1枚だけ、「ここまで」で切り口を見る。軸(X/Y/Z)と◀▶で層を選ぶ。「前後を薄く」で隣の層も半透明に表示。</li>
    <li><b>回転</b>ボタン: 画面の横(X)・縦(Y)・奥行(Z)軸で90°ずつ。⊞で軸にそろえる、⟲0で初期化。</li></ul>
    <p>キー: <kbd>I</kbd><kbd>K</kbd> X軸 / <kbd>J</kbd><kbd>L</kbd> Y軸 / <kbd>U</kbd><kbd>O</kbd> Z軸 / <kbd>[</kbd><kbd>]</kbd> 層 / <kbd>\\</kbd> 層の軸 / <kbd>M</kbd> 層の表示 / <kbd>Space</kbd> 開く / <kbd>F</kbd> 旗 / <kbd>N</kbd> 新規</p>
    <p>左下の矢印は盤面の X(赤)・Y(緑)・Z(青)軸の向き。</p>`);
  $('settings').onclick = () => {
    const d = Solid.dialog(`<h2>設定</h2>
      <p>カスタム盤面(各辺 1〜64、地雷は マス数−1 まで)</p>
      <label>X <input type="number" id="cx" min="1" max="64" value="${custom.d[0]}"></label>
      <label>Y <input type="number" id="cy" min="1" max="64" value="${custom.d[1]}"></label>
      <label>Z <input type="number" id="cz" min="1" max="64" value="${custom.d[2]}"></label>
      <label>地雷 <input type="number" id="cm" min="1" value="${custom.mines}"></label>
      <p id="dens" style="color:var(--sub)"></p>
      <p>表示</p>
      <label>マスの大きさ <input type="number" id="cs" min="0.4" max="1" step="0.02" value="${CONFIG.cubeSize}"></label>
      <label>数字の大きさ <input type="number" id="ns" min="0.3" max="1.2" step="0.02" value="${CONFIG.numberSize}"></label>
      <label><input type="checkbox" id="sa" ${CONFIG.safeArea === 'neighbors' ? 'checked' : ''}> 最初のクリックの周り26マスも安全にする</label>
      <p style="color:var(--sub)">目安: 26方向の数字の期待値 = 26 × 密度。標準の難易度は密度 5.6〜8.1%(端を含めた実際の平均は 0.9〜1.9 で、平面の初級〜上級とほぼ同じ)にしています。</p>`,
      [['キャンセル'], ['適用して新規', () => {
        const v = (id) => +document.getElementById(id).value;
        custom = { d: [v('cx'), v('cy'), v('cz')].map((n) => Math.max(1, Math.min(64, Math.round(n) || 1))), mines: 0 };
        custom.mines = Math.max(1, Math.min(custom.d[0] * custom.d[1] * custom.d[2] - 1, Math.round(v('cm')) || 1));
        CONFIG.cubeSize = Math.max(0.4, Math.min(1, v('cs') || 0.82)); CONFIG.numberSize = Math.max(0.3, Math.min(1.2, v('ns') || 0.72));
        CONFIG.safeArea = document.getElementById('sa').checked ? 'neighbors' : 'cell';
        viewer.onResize(viewer.size().w, viewer.size().h);
        level = { id: 'custom', name: 'カスタム' }; fillLevels(); newGame();
      }]]);
    const upd = () => { const v = (id) => +d.querySelector('#' + id).value; const n = v('cx') * v('cy') * v('cz'); const p = v('cm') / n;
      d.querySelector('#dens').textContent = 'マス ' + n + ' / 密度 ' + (p * 100).toFixed(1) + '% / 数字の期待値 ' + (26 * p).toFixed(2); };
    d.querySelectorAll('input').forEach((e) => e.addEventListener('input', upd)); upd();
  };
  Solid.bindCommonKeys(viewer, layer, (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ' && hover >= 0) { act({ i: hover, kind: state[hover] === OPEN ? 'num' : 'cell' }, 'open'); return true; }
    if (k === 'f' && hover >= 0) { act({ i: hover, kind: 'cell' }, 'flag'); return true; }
    if (k === 'n') { newGame(); return true; }
  });

  fillLevels();
  newGame();
  // テスト用(ブラウザのコンソールから状態を見られるように)
  window.__ms = { get state() { return state; }, get mine() { return mine; }, get count() { return count; }, get dims() { return [nx, ny, nz]; }, get over() { return over; }, get won() { return won; }, reveal: (i) => { reveal(i); rebuild(); status(); }, act, pick, viewer, layer, LEVELS, CONFIG };
})();
