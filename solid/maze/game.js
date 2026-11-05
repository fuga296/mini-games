/* 3D迷路 — 主観視点・上下のない立体迷路 — solid/maze/game.js */
(function () {
  'use strict';
  const T = THREE;
  const CONFIG = {
    size: 5,            // 一辺のマス数(5 → 125 部屋)
    sizes: [3, 4, 5, 6, 7, 8],
    loopRate: 0.0,      // 0=道が1通り(完全迷路)。0.1 なら壁の約1割を追加で開けて回り道を作る
    moveMs: 180,        // 1マス進むアニメーション時間
    turnMs: 200,        // 90°回るアニメーション時間
    lookSpeed: 0.006,   // ドラッグで見回す速さ rad/px(手を離すと最も近い向きにそろう)
    fov: 75,
    fogDensity: 0.22,
    hint: false,        // ゴールの方向を「自分から見て」表示する
    mapShowsAll: false  // 全体図に、まだ通っていない所も表示する
  };
  // 6方向: +x -x +y -y +z -z
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const AX_COL = [0xd9785f, 0x6fbf73, 0x6f95d9]; // 壁の色は「面の向きの軸」で決まる(+と−は同じ色 = 上下の区別はない)
  const $ = (id) => document.getElementById(id);

  let n, N, open, start, goal, pos, visited, moves, t0, tEnd, done;
  const idx = (x, y, z) => x + n * (y + n * z);
  const XYZ = (i) => [i % n, ((i / n) | 0) % n, (i / (n * n)) | 0];

  /* ---- 迷路の生成(3D の穴掘り法 = ランダム深さ優先) ---- */
  function generate() {
    n = CONFIG.size; N = n * n * n;
    open = new Uint8Array(N * 6);
    const seen = new Uint8Array(N), st = [0]; seen[0] = 1;
    while (st.length) {
      const c = st[st.length - 1], [x, y, z] = XYZ(c), cand = [];
      for (let d = 0; d < 6; d++) {
        const xx = x + DIRS[d][0], yy = y + DIRS[d][1], zz = z + DIRS[d][2];
        if (xx < 0 || yy < 0 || zz < 0 || xx >= n || yy >= n || zz >= n) continue;
        const j = idx(xx, yy, zz); if (!seen[j]) cand.push([d, j]);
      }
      if (!cand.length) { st.pop(); continue; }
      const [d, j] = cand[Math.floor(Math.random() * cand.length)];
      open[c * 6 + d] = 1; open[j * 6 + (d ^ 1)] = 1; seen[j] = 1; st.push(j);
    }
    if (CONFIG.loopRate > 0) for (let c = 0; c < N; c++) for (let d = 0; d < 6; d += 2) {
      const [x, y, z] = XYZ(c), xx = x + DIRS[d][0], yy = y + DIRS[d][1], zz = z + DIRS[d][2];
      if (xx >= n || yy >= n || zz >= n || open[c * 6 + d]) continue;
      if (Math.random() < CONFIG.loopRate) { const j = idx(xx, yy, zz); open[c * 6 + d] = 1; open[j * 6 + d + 1] = 1; }
    }
    // スタートは角、ゴールはスタートから最も遠い部屋
    start = 0;
    const dist = new Int32Array(N).fill(-1), q = [start]; dist[start] = 0; let far = start;
    for (let h = 0; h < q.length; h++) { const c = q[h]; if (dist[c] > dist[far]) far = c;
      for (let d = 0; d < 6; d++) if (open[c * 6 + d]) { const [x, y, z] = XYZ(c); const j = idx(x + DIRS[d][0], y + DIRS[d][1], z + DIRS[d][2]); if (dist[j] < 0) { dist[j] = dist[c] + 1; q.push(j); } } }
    goal = far; shortest = dist[far];
  }
  let shortest = 0;

  /* ================= 主観視点 ================= */
  const fpEl = $('fp');
  const renderer = new T.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Solid.CONFIG.maxPixelRatio));
  renderer.domElement.className = 'solid-canvas';
  fpEl.insertBefore(renderer.domElement, fpEl.firstChild);
  const scene = new T.Scene();
  scene.background = new T.Color(0x07080c);
  scene.fog = new T.FogExp2(0x07080c, CONFIG.fogDensity);
  const camera = new T.PerspectiveCamera(CONFIG.fov, 1, 0.02, 100);
  scene.add(camera);
  scene.add(new T.AmbientLight(0xffffff, 0.35));
  const lamp = new T.PointLight(0xffffff, 2.2, 0, 1.2); camera.add(lamp); // 手元の明かり(自分と一緒に動く)
  let walls = null, goalMesh = null, goalLight = null, startMesh = null;

  function wallTexture() {
    const s = 128, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d');
    g.fillStyle = '#c8c8c8'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#e8e8e8'; g.fillRect(10, 10, s - 20, s - 20);
    g.strokeStyle = '#9a9a9a'; g.lineWidth = 2; g.strokeRect(s * 0.3, s * 0.3, s * 0.4, s * 0.4);
    g.fillStyle = '#5a5a5a'; g.fillRect(0, 0, s, 3); g.fillRect(0, s - 3, s, 3); g.fillRect(0, 0, 3, s); g.fillRect(s - 3, 0, 3, s);
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4; return t;
  }
  const wallMat = new T.MeshLambertMaterial({ map: wallTexture(), side: T.DoubleSide });

  function buildScene() {
    if (walls) { scene.remove(walls); walls.dispose(); scene.remove(goalMesh); scene.remove(startMesh); }
    const list = [];
    for (let c = 0; c < N; c++) for (let d = 0; d < 6; d++) {
      if (open[c * 6 + d]) continue;
      const [x, y, z] = XYZ(c), xx = x + DIRS[d][0], yy = y + DIRS[d][1], zz = z + DIRS[d][2];
      const inside = xx >= 0 && yy >= 0 && zz >= 0 && xx < n && yy < n && zz < n;
      if (inside && (d & 1)) continue; // 内側の壁は + 向きの側で1回だけ置く
      list.push([x + 0.5 + DIRS[d][0] * 0.5, y + 0.5 + DIRS[d][1] * 0.5, z + 0.5 + DIRS[d][2] * 0.5, d >> 1]);
    }
    walls = new T.InstancedMesh(new T.PlaneGeometry(1, 1), wallMat, list.length);
    const m = new T.Matrix4(), q = new T.Quaternion(), one = new T.Vector3(1, 1, 1), col = new T.Color();
    const rot = [new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), Math.PI / 2), new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), Math.PI / 2), new T.Quaternion()];
    list.forEach(([x, y, z, a], k) => {
      q.copy(rot[a]); m.compose(new T.Vector3(x, y, z), q, one); walls.setMatrixAt(k, m);
      col.setHex(AX_COL[a]); walls.setColorAt(k, col);
    });
    scene.add(walls);
    const [gx, gy, gz] = XYZ(goal);
    goalMesh = new T.Mesh(new T.OctahedronGeometry(0.2), new T.MeshBasicMaterial({ color: 0xffd25a }));
    goalMesh.position.set(gx + 0.5, gy + 0.5, gz + 0.5);
    goalLight = new T.PointLight(0xffd25a, 1.2, 2.5, 1); goalMesh.add(goalLight);
    scene.add(goalMesh);
    const [sx, sy, sz] = XYZ(start);
    startMesh = new T.Mesh(new T.TorusGeometry(0.12, 0.02, 8, 24), new T.MeshBasicMaterial({ color: 0x7fe0ff }));
    startMesh.position.set(sx + 0.5, sy + 0.5, sz + 0.5); scene.add(startMesh);
  }

  /* ---- 自分の向きと位置 ---- */
  const cur = { q: new T.Quaternion(), p: new T.Vector3() };   // 表示中
  const tgt = { q: new T.Quaternion(), p: new T.Vector3() };   // 行き先(向きは必ず24通りのどれか)
  let anim = null, queued = null, look = null; // look: ドラッグ中の見回し
  const forwardDir = (q) => dirIndex(new T.Vector3(0, 0, -1).applyQuaternion(q));
  function dirIndex(v) {
    const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)]; const ax = a[0] > a[1] ? (a[0] > a[2] ? 0 : 2) : (a[1] > a[2] ? 1 : 2);
    return ax * 2 + ([v.x, v.y, v.z][ax] > 0 ? 0 : 1);
  }
  function cellCenter(i) { const [x, y, z] = XYZ(i); return new T.Vector3(x + 0.5, y + 0.5, z + 0.5); }

  function action(a) {
    if (done) return;
    if (anim) { queued = a; return; }
    const L = (axis, ang) => tgt.q.clone().multiply(new T.Quaternion().setFromAxisAngle(axis, ang)); // 自分の軸で回る
    const H = Math.PI / 2, X = new T.Vector3(1, 0, 0), Y = new T.Vector3(0, 1, 0), Z = new T.Vector3(0, 0, 1);
    let q2 = null, p2 = null;
    if (a === 'yawL') q2 = L(Y, H); else if (a === 'yawR') q2 = L(Y, -H);
    else if (a === 'pitchU') q2 = L(X, H); else if (a === 'pitchD') q2 = L(X, -H);
    else if (a === 'rollL') q2 = L(Z, H); else if (a === 'rollR') q2 = L(Z, -H);
    else if (a === 'fwd' || a === 'back') {
      let d = forwardDir(tgt.q); if (a === 'back') d ^= 1;
      if (!open[pos * 6 + d]) { bump(); return; }
      const [x, y, z] = XYZ(pos); pos = idx(x + DIRS[d][0], y + DIRS[d][1], z + DIRS[d][2]);
      visited[pos] = 1; moves++; if (!t0) t0 = performance.now();
      p2 = cellCenter(pos);
    }
    if (q2) { q2.copy(Solid.snapQuaternion(q2)); }
    anim = { q0: cur.q.clone(), q1: q2 || tgt.q.clone(), p0: cur.p.clone(), p1: p2 || tgt.p.clone(), t: 0, ms: p2 ? CONFIG.moveMs : CONFIG.turnMs };
    tgt.q.copy(anim.q1); tgt.p.copy(anim.p1);
    wake(); status(); updateHud();
    if (pos === goal) win();
  }
  let bumpT = 0;
  function bump() { bumpT = 0.25; toast('壁です'); wake(); }

  function win() {
    done = true; tEnd = performance.now();
    setTimeout(() => Solid.dialog('<h2>🎉 ゴール!</h2><p>' + moves + ' 歩(最短 ' + shortest + ' 歩) / ' + Solid.formatTime((tEnd - t0) / 1000) + '</p>', [['閉じる'], ['新しい迷路', newGame]]), 300);
  }

  // ドラッグで自由に見回し、離すと最も近い向き(24通り)にそろう
  Solid.gestures(renderer.domElement, {
    onDrag: (dx, dy) => {
      if (anim || done) return;
      look = look || tgt.q.clone();
      const qy = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), dx * CONFIG.lookSpeed);
      const qx = new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), dy * CONFIG.lookSpeed);
      look.multiply(qy).multiply(qx); cur.q.copy(look); wake();
    },
    onDragEnd: () => {
      if (!look) return;
      const s = Solid.snapQuaternion(look); look = null;
      anim = { q0: cur.q.clone(), q1: s, p0: cur.p.clone(), p1: tgt.p.clone(), t: 0, ms: CONFIG.turnMs };
      tgt.q.copy(s); wake(); updateHud();
    },
    onPinch: (s) => { camera.fov = T.MathUtils.clamp(camera.fov / s, 40, 110); camera.updateProjectionMatrix(); wake(); },
    onWheel: (d) => { camera.fov = T.MathUtils.clamp(camera.fov * Math.exp(d * 0.001), 40, 110); camera.updateProjectionMatrix(); wake(); }
  });

  let raf = 0, last = 0;
  function wake() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function frame(now) {
    raf = 0; const dt = Math.min(0.1, (now - last) / 1000); last = now;
    let busy = true; // ゴールが回っているので主観視点では常に描く(地図表示中は止める)
    if (anim) {
      anim.t += dt * 1000; const k = Math.min(1, anim.t / anim.ms), e = k * (2 - k);
      cur.q.slerpQuaternions(anim.q0, anim.q1, e); cur.p.lerpVectors(anim.p0, anim.p1, e);
      if (k >= 1) { anim = null; if (queued) { const a = queued; queued = null; action(a); } }
    }
    const shake = bumpT > 0 ? Math.sin(bumpT * 60) * 0.02 * bumpT * 4 : 0; bumpT = Math.max(0, bumpT - dt);
    camera.quaternion.copy(cur.q);
    camera.position.copy(cur.p).add(new T.Vector3(shake, 0, 0).applyQuaternion(cur.q));
    if (goalMesh) { goalMesh.rotation.x += dt * 0.9; goalMesh.rotation.y += dt * 1.3; }
    if (document.body.classList.contains('mapmode')) busy = false;
    renderer.render(scene, camera);
    if (busy) wake();
  }
  function resizeFp() {
    const w = Math.max(1, fpEl.clientWidth), h = Math.max(1, fpEl.clientHeight);
    renderer.setSize(w, h, false); renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px';
    camera.aspect = w / h; camera.updateProjectionMatrix(); wake();
  }
  new ResizeObserver(resizeFp).observe(fpEl);

  /* ---- 自分から見た情報(世界の「上」は使わない) ---- */
  function rel(d) { // 世界の方向 d が、自分から見てどちらか
    const v = new T.Vector3(...DIRS[d]).applyQuaternion(tgt.q.clone().invert());
    return ['右', '左', '頭上', '足元', '後ろ', '前'][dirIndex(v)];
  }
  function updateHud() {
    const ways = [];
    for (let d = 0; d < 6; d++) if (open[pos * 6 + d]) ways.push(rel(d));
    const order = ['前', '後ろ', '左', '右', '頭上', '足元'];
    ways.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    $('paths').textContent = '通れる方向: ' + (ways.join('・') || 'なし');
    if (CONFIG.hint && !done) {
      const dv = cellCenter(goal).sub(cellCenter(pos)).applyQuaternion(tgt.q.clone().invert());
      const r = (v, p, m) => Math.round(v) === 0 ? '' : (Math.round(v) > 0 ? p : m) + Math.abs(Math.round(v)) + ' ';
      $('hint').textContent = 'ゴール: ' + (r(-dv.z, '前', '後ろ') + r(dv.x, '右', '左') + r(dv.y, '頭上', '足元')).trim();
    } else $('hint').textContent = '';
  }

  /* ================= 全体図(共有ビューア + 層の切り替え) ================= */
  const mapEl = $('map'), mapctl = $('mapctl');
  const mv = Solid.createViewer(mapEl, { background: 0x0d1016 });
  const mlf = new Solid.LayerFrame(mv.board);
  const mlayer = Solid.createLayerControl(mapctl, { dims: [5, 5, 5], axis: 2, ghost: true, onChange: () => { mlf.update([n, n, n], mlayer.state); buildMap(); } });
  Solid.createRotateControls(mapctl, mv);
  let mapGroup = null;
  const nodeGeo = new T.BoxGeometry(0.26, 0.26, 0.26);
  function buildMap() {
    if (!document.body.classList.contains('mapmode')) return;
    if (mapGroup) { mv.board.remove(mapGroup); mapGroup.traverse((o) => { if (o.material && o.material !== shared.node && o.material !== shared.ghost) o.material.dispose(); if (o.geometry && o.geometry !== nodeGeo) o.geometry.dispose(); }); }
    mapGroup = new T.Group(); mv.board.add(mapGroup);
    const known = (i) => CONFIG.mapShowsAll || visited[i];
    const nodes = [], ghostNodes = [], segs = [], gsegs = [];
    for (let c = 0; c < N; c++) {
      if (!known(c)) continue;
      const [x, y, z] = XYZ(c), v = mlayer.vis(x, y, z); if (!v) continue;
      (v === 2 ? nodes : ghostNodes).push(c);
      for (let d = 0; d < 6; d += 2) if (open[c * 6 + d]) {
        const j = idx(x + DIRS[d][0], y + DIRS[d][1], z + DIRS[d][2]); if (!known(j)) continue;
        const [a, b, cc] = XYZ(j), v2 = mlayer.vis(a, b, cc); if (!v2) continue;
        (v === 2 && v2 === 2 ? segs : gsegs).push(x + 0.5, y + 0.5, z + 0.5, a + 0.5, b + 0.5, cc + 0.5);
      }
    }
    const inst = (list, mat) => { const m = new T.InstancedMesh(nodeGeo, mat, Math.max(1, list.length)); m.count = list.length; const M = new T.Matrix4();
      list.forEach((c, k) => { const [x, y, z] = XYZ(c); M.makeTranslation(x + 0.5, y + 0.5, z + 0.5); m.setMatrixAt(k, M); }); mapGroup.add(m); };
    inst(nodes, shared.node); inst(ghostNodes, shared.ghost);
    const lines = (arr, color, op) => { const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(arr, 3));
      mapGroup.add(new T.LineSegments(g, new T.LineBasicMaterial({ color, transparent: op < 1, opacity: op }))); };
    lines(segs, 0x9fb8e8, 1); lines(gsegs, 0x9fb8e8, 0.18);
    // 自分(水色の矢印 = 前の向き)とゴール(黄)
    const me = new T.Group(); me.position.copy(cellCenter(pos)); me.quaternion.copy(tgt.q);
    const cone = new T.Mesh(new T.ConeGeometry(0.16, 0.42, 16), new T.MeshLambertMaterial({ color: 0x7fe0ff, emissive: 0x1a4050 }));
    cone.rotation.x = -Math.PI / 2; me.add(cone);
    const head = new T.Mesh(new T.BoxGeometry(0.04, 0.2, 0.04), new T.MeshBasicMaterial({ color: 0xffffff })); head.position.set(0, 0.16, 0.08); me.add(head); // 頭の方向
    mapGroup.add(me);
    const gm = new T.Mesh(new T.OctahedronGeometry(0.22), new T.MeshBasicMaterial({ color: 0xffd25a })); gm.position.copy(cellCenter(goal)); mapGroup.add(gm); // ゴールは常に表示
    mv.render();
  }
  const shared = {
    node: new T.MeshLambertMaterial({ color: 0x8ea6d6 }),
    ghost: new T.MeshBasicMaterial({ color: 0x8ea6d6, transparent: true, opacity: 0.15, depthWrite: false })
  };
  function toggleMap(on) {
    on = on == null ? !document.body.classList.contains('mapmode') : on;
    document.body.classList.toggle('mapmode', on);
    $('mapbtn').classList.toggle('on', on);
    if (on) {
      mv.setBounds(new T.Vector3(n, n, n)); mv.reset(false);
      mv.pivot.quaternion.copy(new T.Quaternion().setFromEuler(new T.Euler(-0.35, 0.45, 0)).multiply(tgt.q.clone().invert())); // 地図は「今の自分の向き」から少し斜めに見た形で開く
      buildMap(); mv.resize();
    } else { resizeFp(); }
  }

  /* ================= ゲーム ================= */
  function newGame() {
    generate(); buildScene();
    pos = start; visited = new Uint8Array(N); visited[start] = 1; moves = 0; t0 = tEnd = 0; done = false; anim = null; queued = null; look = null;
    tgt.p.copy(cellCenter(start)); cur.p.copy(tgt.p);
    tgt.q.identity();
    for (let k = 0; k < 6 && !open[start * 6 + forwardDir(tgt.q)]; k++) // 通路のある方を向いて始める
      tgt.q.multiply(new T.Quaternion().setFromAxisAngle(k % 2 ? new T.Vector3(1, 0, 0) : new T.Vector3(0, 1, 0), Math.PI / 2));
    tgt.q.copy(Solid.snapQuaternion(tgt.q)); cur.q.copy(tgt.q);
    mlayer.setDims([n, n, n]); mlf.update([n, n, n], mlayer.state);
    toggleMap(false); status(); updateHud(); wake();
  }
  function status() {
    $('moves').textContent = moves + ' 歩';
    $('time').textContent = '⏱ ' + Solid.formatTime(t0 ? ((tEnd || performance.now()) - t0) / 1000 : 0);
  }
  setInterval(status, 250);
  let tt = 0;
  function toast(s) { const e = $('toast'); e.textContent = s; e.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => e.classList.remove('show'), 1000); }

  /* ---- UI ---- */
  for (const id of ['yawL', 'yawR', 'pitchU', 'pitchD', 'rollL', 'rollR', 'fwd', 'back']) $(id).onclick = () => action(id);
  const sz = $('size');
  for (const s of CONFIG.sizes) { const o = document.createElement('option'); o.value = s; o.textContent = s + '×' + s + '×' + s; sz.appendChild(o); }
  sz.value = CONFIG.size; sz.onchange = () => { CONFIG.size = +sz.value; newGame(); };
  $('newgame').onclick = newGame;
  $('mapbtn').onclick = () => toggleMap();
  Solid.bindCommonKeys(mv, mlayer, (e) => {
    const k = e.key.toLowerCase();
    if (k === 'tab') { toggleMap(); return true; }
    if (document.body.classList.contains('mapmode')) return k === 'escape' ? (toggleMap(false), true) : undefined;
    const m = { w: 'fwd', ' ': 'fwd', s: 'back', a: 'yawL', arrowleft: 'yawL', d: 'yawR', arrowright: 'yawR', r: 'pitchU', arrowup: 'pitchU', f: 'pitchD', arrowdown: 'pitchD', q: 'rollL', e: 'rollR' }[k];
    if (m) { action(m); return true; }
    if (k === 'n') { newGame(); return true; }
    return false;
  });
  $('help').onclick = () => Solid.dialog(`<h2>遊び方</h2>
    <ul><li>立方体の部屋がつながった立体迷路。黄色い八面体がゴール。</li>
    <li>この世界に<b>決まった「上」はありません</b>。前後・左右・頭上・足元は、すべて<b>自分の向き</b>が基準です。</li>
    <li><b>▲前進 / ▼後退</b>: 向いている方へ1部屋進む/下がる。</li>
    <li><b>↶ ↷</b>: 左右を向く。<b>⤒ ⤓</b>: 頭の方/足の方を向く。<b>⟲ ⟳</b>: その場で傾く(前は変わらない)。どれも90°ずつ。</li>
    <li><b>ドラッグ</b>: 自由に見回す。指を離すと一番近い向きにそろいます(大きくドラッグすると向きが変わる)。<b>ピンチ/ホイール</b>: 視野の広さ。</li>
    <li>壁の色は面の向きで3色(同じ軸なら両側同じ色)なので、向きの手がかりにはなりますが「上」は示しません。</li>
    <li><b>🗺 全体図</b>: 通った部屋とつながりを外から見る。回転・拡大縮小・層の切り替えは他の2つのゲームと同じ操作です。水色の矢印が自分(白い棒が頭の方)。地図は開いた時の自分の向きから見た形で表示されます。</li></ul>
    <p>キー: <kbd>W</kbd>/<kbd>Space</kbd> 前進 / <kbd>S</kbd> 後退 / <kbd>A</kbd><kbd>D</kbd>/<kbd>←</kbd><kbd>→</kbd> 左右 / <kbd>R</kbd><kbd>F</kbd>/<kbd>↑</kbd><kbd>↓</kbd> 頭/足の方 / <kbd>Q</kbd><kbd>E</kbd> 傾く / <kbd>Tab</kbd> 全体図</p>`);
  $('settings').onclick = () => Solid.dialog(`<h2>設定</h2>
    <label>回り道の割合 <input type="number" id="lr" min="0" max="0.5" step="0.05" value="${CONFIG.loopRate}"></label> <span style="color:var(--sub)">0 = 道が1通り</span><br>
    <label>霧の濃さ <input type="number" id="fg" min="0" max="1" step="0.02" value="${CONFIG.fogDensity}"></label><br>
    <label><input type="checkbox" id="hn" ${CONFIG.hint ? 'checked' : ''}> ゴールの方向を表示(自分から見た向き)</label><br>
    <label><input type="checkbox" id="ma" ${CONFIG.mapShowsAll ? 'checked' : ''}> 全体図に通っていない所も表示</label>
    <p style="color:var(--sub)">回り道の割合を変えると新しい迷路になります。</p>`,
    [['キャンセル'], ['適用', () => {
      const g = (id) => document.getElementById(id);
      const lr = Math.max(0, Math.min(0.5, +g('lr').value || 0)), changed = lr !== CONFIG.loopRate;
      CONFIG.loopRate = lr; CONFIG.fogDensity = Math.max(0, Math.min(1, +g('fg').value || 0)); scene.fog.density = CONFIG.fogDensity;
      CONFIG.hint = g('hn').checked; CONFIG.mapShowsAll = g('ma').checked;
      if (changed) newGame(); else { updateHud(); buildMap(); wake(); }
    }]]);

  newGame();
  window.__mz = { action, toggleMap, get pos() { return pos; }, get goal() { return goal; }, get open() { return open; }, get n() { return n; }, get q() { return tgt.q; }, get moves() { return moves; }, get done() { return done; }, CONFIG, DIRS, mv, mlayer, newGame };
})();
