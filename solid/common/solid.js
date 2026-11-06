/* solid/common/solid.js
 * 3つの立体ゲームで共有する操作部品。
 *  - Solid.gestures       : タップ / 長押し / ドラッグ / ピンチ / 2本指パン / ホイール
 *  - Solid.createViewer   : 盤面全体の回転(ドラッグ・x/y/z軸90°ボタン)・拡大縮小・パン
 *  - Solid.createLayerControl : 層(レイヤー)の切り替え(全体 / 単層 / ここまで、前後の層を薄く)
 *  - Solid.LayerFrame     : いま選んでいる層を盤面上に枠で示す
 *  - Solid.snapQuaternion : 回転を最も近い「軸がそろった向き」(24通り)に丸める
 * 依存: three.min.js (グローバル THREE)。外部との通信はしない。
 */
(function () {
  'use strict';
  const T = THREE;
  const Solid = {};

  /* ---- 共通設定(ここを変えると3つのゲームすべてに効く) ---- */
  Solid.CONFIG = {
    tapMaxMove: 10,       // px: これ以上動いたらタップではなくドラッグ
    longPressMs: 450,     // ms: 長押しと判定する時間
    rotateSpeed: 0.009,   // rad/px: ドラッグ回転の速さ
    wheelZoom: 0.0015,    // ホイール1単位あたりの拡大率
    axisRotateMs: 220,    // ms: 90°回転ボタンのアニメーション時間
    minZoom: 0.25,        // 最も近づいたときの距離(画面いっぱいの何倍か)
    maxZoom: 3.5,         // 最も離れたときの距離
    maxPixelRatio: 2,     // 高解像度端末での描画倍率の上限(重さ対策)
    initialTilt: [-0.55, 0.65], // 初期の傾き [x軸, y軸] rad
    inertia: 0.94,        // 離したあとの慣性(1フレームあたりの残り。0 で慣性なし、1に近いほど長く回る)
    inertiaMinSpeed: 0.15 // rad/s: これより遅くなったら止める
  };

  /* ================= ジェスチャー ================= */
  Solid.gestures = function (el, h) {
    const C = Solid.CONFIG;
    const pts = new Map();
    let mode = null; // 'pending' | 'drag' | 'multi' | 'rest' | null
    let start = null, last = null, timer = 0, claimed = false;
    let pinch0 = 0, center0 = null;
    const loc = (e) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const two = () => { const a = [...pts.values()]; return { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y), c: { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 } }; };

    el.addEventListener('pointerdown', (e) => {
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      const p = loc(e);
      pts.set(e.pointerId, p);
      if (pts.size === 1) {
        mode = 'pending';
        start = { x: p.x, y: p.y, button: e.button, shift: e.shiftKey, type: e.pointerType };
        last = { x: p.x, y: p.y };
        claimed = false;
        clearTimeout(timer);
        if (e.button === 0) timer = setTimeout(() => {
          if (mode === 'pending') { mode = 'rest'; if (navigator.vibrate) navigator.vibrate(25); h.onLongPress && h.onLongPress(start.x, start.y, start); }
        }, C.longPressMs);
      } else if (pts.size === 2) {
        clearTimeout(timer);
        if (mode === 'drag' && h.onDragEnd) h.onDragEnd(0, 0, last.x, last.y, claimed, true);
        mode = 'multi';
        const t = two(); pinch0 = t.d; center0 = t.c;
      }
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      const p = loc(e);
      if (!pts.has(e.pointerId)) { if (e.pointerType === 'mouse' && h.onHover) h.onHover(p.x, p.y); return; }
      pts.set(e.pointerId, p);
      if (mode === 'pending') {
        if (Math.hypot(p.x - start.x, p.y - start.y) > C.tapMaxMove) {
          clearTimeout(timer);
          mode = 'drag';
          claimed = !!(h.onDragStart && h.onDragStart(start.x, start.y, start, p.x - start.x, p.y - start.y));
        }
      }
      if (mode === 'drag') {
        h.onDrag && h.onDrag(p.x - last.x, p.y - last.y, p.x, p.y, claimed, start);
        last = p;
      } else if (mode === 'multi' && pts.size >= 2) {
        const t = two();
        if (pinch0 > 0 && h.onPinch) h.onPinch(t.d / pinch0, t.c.x, t.c.y);
        if (h.onPan) h.onPan(t.c.x - center0.x, t.c.y - center0.y);
        pinch0 = t.d; center0 = t.c;
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      const p = pts.get(e.pointerId);
      pts.delete(e.pointerId);
      clearTimeout(timer);
      if (mode === 'pending' && e.type === 'pointerup') { h.onTap && h.onTap(start.x, start.y, start); }
      else if (mode === 'drag') { h.onDragEnd && h.onDragEnd(p.x - start.x, p.y - start.y, p.x, p.y, claimed, false); }
      if (pts.size === 0) mode = null; else if (mode === 'multi') mode = 'rest';
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => { e.preventDefault(); h.onWheel && h.onWheel(e.deltaY * (e.deltaMode === 1 ? 30 : 1)); }, { passive: false });
  };

  /* ================= 向きの丸め(24通り) ================= */
  Solid.snapQuaternion = function (q) {
    const m = new T.Matrix4().makeRotationFromQuaternion(q);
    const cols = [new T.Vector3(), new T.Vector3(), new T.Vector3()];
    m.extractBasis(cols[0], cols[1], cols[2]);
    const used = [false, false, false];
    const out = [];
    for (let k = 0; k < 2; k++) {
      const v = cols[k]; const a = [v.x, v.y, v.z];
      let best = -1, bv = -1;
      for (let i = 0; i < 3; i++) if (!used[i] && Math.abs(a[i]) > bv) { bv = Math.abs(a[i]); best = i; }
      used[best] = true;
      const u = new T.Vector3(); u.setComponent(best, Math.sign(a[best]) || 1); out.push(u);
    }
    out.push(new T.Vector3().crossVectors(out[0], out[1]));
    const r = new T.Matrix4().makeBasis(out[0], out[1], out[2]);
    return new T.Quaternion().setFromRotationMatrix(r);
  };

  /* ================= 盤面ビューア ================= */
  // opts: { background, onTap(x,y,info), onLongPress(x,y,info), onHover(x,y), claimDrag(x,y,info)->bool,
  //         onClaimedDrag(dx,dy,x,y), onClaimedDragEnd(dx,dy,x,y), gizmo: true }
  Solid.createViewer = function (container, opts) {
    opts = opts || {};
    const C = Solid.CONFIG;
    const renderer = new T.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, C.maxPixelRatio));
    renderer.autoClear = false;
    const canvas = renderer.domElement;
    canvas.className = 'solid-canvas';
    container.appendChild(canvas);

    const scene = new T.Scene();
    scene.background = new T.Color(opts.background != null ? opts.background : 0x12151c);
    const camera = new T.PerspectiveCamera(45, 1, 0.05, 2000);
    scene.add(camera);
    scene.add(new T.HemisphereLight(0xffffff, 0x445066, 1.6));
    const key = new T.DirectionalLight(0xffffff, 1.6); key.position.set(0.6, 0.9, 1); camera.add(key); // 視点に固定した照明
    const pivot = new T.Group(); scene.add(pivot);   // 回転の中心
    const board = new T.Group(); pivot.add(board);   // ここにゲームの中身を置く(セル座標)

    let size = new T.Vector3(1, 1, 1), fit = 3, zoom = 1;
    const pan = new T.Vector2();
    const ticks = new Set();
    let dirty = true, W = 1, H = 1;

    function updateCamera() {
      const d = fit * zoom;
      camera.position.set(pan.x * d, pan.y * d, d);
      camera.lookAt(pan.x * d, pan.y * d, 0);
      dirty = true; wake();
    }
    function computeFit() {
      const r = size.length() / 2;
      const vf = T.MathUtils.degToRad(camera.fov) / 2;
      const hf = Math.atan(Math.tan(vf) * camera.aspect);
      fit = r / Math.sin(Math.min(vf, hf)) * 1.02;
      camera.near = Math.max(0.01, fit * 0.01); camera.far = fit * 20;
      camera.updateProjectionMatrix();
    }
    function resize() {
      W = Math.max(1, container.clientWidth); H = Math.max(1, container.clientHeight);
      renderer.setSize(W, H, false);
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      camera.aspect = W / H; computeFit(); updateCamera();
      api.onResize && api.onResize(W, H);
    }

    // ---- 回転アニメーション ----
    let rotAnim = null;
    function animateTo(q, ms) {
      spin = null;
      rotAnim = { from: pivot.quaternion.clone(), to: q.clone(), t: 0, ms: ms == null ? C.axisRotateMs : ms };
      wake();
    }
    function rotateScreen(axis, angle, animate) { // axis: 0=画面x(横) 1=画面y(縦) 2=画面z(奥行)
      const a = new T.Vector3(); a.setComponent(axis, 1);
      spin = null;
      const base = rotAnim ? rotAnim.to : pivot.quaternion;
      const q = new T.Quaternion().setFromAxisAngle(a, angle).multiply(base);
      if (animate === false) { rotAnim = null; pivot.quaternion.copy(q); dirty = true; wake(); } else animateTo(q);
      api.onRotate && api.onRotate();
    }
    const defaultQuat = () => new T.Quaternion().setFromEuler(new T.Euler(C.initialTilt[0], C.initialTilt[1], 0, 'XYZ'));

    // ---- ジェスチャー ----
    Solid.gestures(canvas, {
      onTap: (x, y, i) => opts.onTap && opts.onTap(x, y, i),
      onLongPress: (x, y, i) => opts.onLongPress && opts.onLongPress(x, y, i),
      onHover: (x, y) => opts.onHover && opts.onHover(x, y),
      onDragStart: (x, y, i, dx, dy) => { spin = null; vel.set(0, 0); lastMove = performance.now(); return i.button === 0 && !i.shift && opts.claimDrag ? opts.claimDrag(x, y, i, dx, dy) : false; },
      onDrag: (dx, dy, x, y, claimed, s) => {
        if (claimed) { opts.onClaimedDrag && opts.onClaimedDrag(dx, dy, x, y); return; }
        if (s.button === 2 || s.button === 1 || s.shift) { panBy(dx, dy); return; }
        rotAnim = null; spin = null;
        const now = performance.now(), dt = Math.max(1, now - lastMove) / 1000; lastMove = now;
        vel.set(vel.x * 0.5 + (dx / dt) * 0.5, vel.y * 0.5 + (dy / dt) * 0.5); // 直近の指の速さ(px/s)
        dragRotate(dx, dy);
      },
      onDragEnd: (dx, dy, x, y, claimed, cancelled) => {
        if (claimed) { opts.onClaimedDragEnd && opts.onClaimedDragEnd(dx, dy, x, y, cancelled); return; }
        // 指を止めてから離したときは慣性なし。動かしたまま離したときだけ回り続ける
        if (cancelled || !C.inertia || performance.now() - lastMove > 120) return;
        const sp = Math.hypot(vel.x, vel.y) * C.rotateSpeed;
        if (sp > C.inertiaMinSpeed * 3) { spin = { x: vel.x, y: vel.y }; wake(); }
      },
      onPinch: (s) => setZoom(zoom / s),
      onPan: (dx, dy) => panBy(dx, dy),
      onWheel: (d) => setZoom(zoom * Math.exp(d * C.wheelZoom))
    });
    let spin = null, lastMove = 0; const vel = new T.Vector2();
    function dragRotate(dx, dy) {
      const len = Math.hypot(dx, dy); if (!len) return;
      const q = new T.Quaternion().setFromAxisAngle(new T.Vector3(dy / len, dx / len, 0), len * C.rotateSpeed);
      pivot.quaternion.premultiply(q); dirty = true; wake();
      api.onRotate && api.onRotate();
    }
    function panBy(dx, dy) {
      const k = 2 * Math.tan(T.MathUtils.degToRad(camera.fov) / 2) / H;
      pan.x -= dx * k; pan.y += dy * k; updateCamera();
    }
    function setZoom(z) { zoom = T.MathUtils.clamp(z, C.minZoom, C.maxZoom); updateCamera(); api.onZoom && api.onZoom(zoom); }

    // ---- 軸ギズモ(盤面の X/Y/Z の向きを左下に表示) ----
    let gizmo = null;
    if (opts.gizmo !== false) {
      gizmo = { scene: new T.Scene(), cam: new T.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10), root: new T.Group() };
      gizmo.cam.position.set(0, 0, 5);
      gizmo.scene.add(gizmo.root);
      const cols = [0xff5a5a, 0x5ad35a, 0x5a9bff], names = ['X', 'Y', 'Z'];
      for (let i = 0; i < 3; i++) {
        const dir = new T.Vector3(); dir.setComponent(i, 1);
        gizmo.root.add(new T.ArrowHelper(dir, new T.Vector3(), 1.05, cols[i], 0.32, 0.2));
        const sp = new T.Sprite(new T.SpriteMaterial({ map: Solid.textTexture(names[i], '#' + cols[i].toString(16).padStart(6, '0')), depthTest: false }));
        sp.position.copy(dir).multiplyScalar(1.35); sp.scale.set(0.55, 0.55, 1); gizmo.root.add(sp);
      }
    }

    // ---- 描画ループ(変化があったときだけ描く) ----
    let lastT = performance.now(), raf = 0;
    function frame(now) {
      raf = 0;
      const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
      let busy = false;
      if (rotAnim) {
        rotAnim.t += dt * 1000;
        const k = Math.min(1, rotAnim.t / rotAnim.ms), e = k * (2 - k);
        pivot.quaternion.slerpQuaternions(rotAnim.from, rotAnim.to, e);
        if (k >= 1) rotAnim = null; else busy = true;
        dirty = true; api.onRotate && api.onRotate();
      }
      if (spin) {
        const f = Math.pow(C.inertia, dt * 60);
        spin.x *= f; spin.y *= f;
        if (Math.hypot(spin.x, spin.y) * C.rotateSpeed < C.inertiaMinSpeed) spin = null;
        else { dragRotate(spin.x * dt, spin.y * dt); busy = true; }
      }
      for (const f of ticks) { if (f(dt)) busy = true; else ticks.delete(f); dirty = true; }
      if (dirty || busy) {
        dirty = false;
        renderer.setViewport(0, 0, W, H); renderer.setScissorTest(false); renderer.clear();
        renderer.render(scene, camera);
        if (gizmo) {
          const s = Math.min(96, Math.round(Math.min(W, H) * 0.22));
          gizmo.root.quaternion.copy(pivot.quaternion);
          renderer.setViewport(6, 6, s, s); renderer.setScissor(6, 6, s, s); renderer.setScissorTest(true);
          renderer.clearDepth(); renderer.render(gizmo.scene, gizmo.cam); renderer.setScissorTest(false);
        }
      }
      if (busy) wake();
    }
    function wake() { if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(frame); } }

    const api = {
      renderer, scene, camera, pivot, board, canvas,
      /** 盤面の大きさ(セル単位)を設定し、中心を合わせる */
      setBounds(v) { size = v.clone(); board.position.set(-v.x / 2, -v.y / 2, -v.z / 2); computeFit(); updateCamera(); },
      render() { dirty = true; wake(); },
      addTick(f) { ticks.add(f); wake(); },
      rotateScreen,
      snap() { animateTo(Solid.snapQuaternion(rotAnim ? rotAnim.to : pivot.quaternion)); },
      reset(animate) { pan.set(0, 0); zoom = 1; updateCamera(); if (animate === false) { pivot.quaternion.copy(defaultQuat()); dirty = true; } else animateTo(defaultQuat(), 300); },
      setZoom, getZoom: () => zoom,
      /** 盤面ローカル座標(セル座標)での視線 */
      localRay(x, y) {
        const ndc = new T.Vector2(x / W * 2 - 1, -(y / H) * 2 + 1);
        const rc = new T.Raycaster(); scene.updateMatrixWorld(); rc.setFromCamera(ndc, camera);
        const inv = new T.Matrix4().copy(board.matrixWorld).invert();
        return rc.ray.clone().applyMatrix4(inv);
      },
      raycaster(x, y) { const rc = new T.Raycaster(); scene.updateMatrixWorld(); rc.setFromCamera(new T.Vector2(x / W * 2 - 1, -(y / H) * 2 + 1), camera); return rc; },
      /** 盤面の軸ベクトルが画面上でどちらを向くか (x右, y上, z手前) */
      axisOnScreen(axisVec) { return axisVec.clone().applyQuaternion(rotAnim ? rotAnim.to : pivot.quaternion); },
      size: () => ({ w: W, h: H }),
      resize
    };
    new ResizeObserver(resize).observe(container);
    resize(); api.reset(false);
    return api;
  };

  /* ================= 回転ボタン ================= */
  // container に 「X軸↑↓ / Y軸←→ / Z軸⟲⟳ / そろえる / リセット」を並べる。軸は画面の x(横)・y(縦)・z(奥行)。
  Solid.createRotateControls = function (container, viewer) {
    const H = Math.PI / 2;
    const defs = [
      ['X↑', '画面の横(x)軸で上へ90°回す', () => viewer.rotateScreen(0, -H)],
      ['X↓', '画面の横(x)軸で下へ90°回す', () => viewer.rotateScreen(0, H)],
      ['Y←', '画面の縦(y)軸で左へ90°回す', () => viewer.rotateScreen(1, -H)],
      ['Y→', '画面の縦(y)軸で右へ90°回す', () => viewer.rotateScreen(1, H)],
      ['Z⟲', '画面の奥行(z)軸で左回りに90°回す', () => viewer.rotateScreen(2, H)],
      ['Z⟳', '画面の奥行(z)軸で右回りに90°回す', () => viewer.rotateScreen(2, -H)],
      ['⊞', '向きを軸にそろえる', () => viewer.snap()],
      ['⟲0', '向きと拡大を初期に戻す', () => viewer.reset()],
      ['＋', '拡大', () => viewer.setZoom(viewer.getZoom() / 1.25)],
      ['－', '縮小', () => viewer.setZoom(viewer.getZoom() * 1.25)]
    ];
    const wrap = el('div', 'solid-row solid-rot');
    wrap.appendChild(el('span', 'solid-label', '回転'));
    for (const [t, title, f] of defs) { const b = el('button', 'solid-btn', t); b.title = title; b.setAttribute('aria-label', title); b.onclick = f; wrap.appendChild(b); }
    container.appendChild(wrap);
    return wrap;
  };

  /* ================= 盤面の上に重ねる回転パッド =================
   * 3×3: [Z⟲][↑][Z⟳] / [←][⊞][→] / [＋][↓][－]
   * タップ = 90°回す(アニメーション)。押し続ける = なめらかに連続回転。⊞ = 軸にそろえる(長押しで初期化) */
  Solid.createRotatePad = function (stage, viewer) {
    const pad = el('div', 'solid-pad');
    const H = Math.PI / 2, RATE = 2.2; // rad/s(連続回転)
    const defs = [
      ['Z⟲', 'Z軸(奥行)で左回り', 2, 1], ['↑', 'X軸(横)で上へ回す', 0, -1], ['Z⟳', 'Z軸(奥行)で右回り', 2, -1],
      ['←', 'Y軸(縦)で左へ回す', 1, -1], ['⊞', '軸にそろえる(長押しで初期化)'], ['→', 'Y軸(縦)で右へ回す', 1, 1],
      ['＋', '拡大'], ['↓', 'X軸(横)で下へ回す', 0, 1], ['－', '縮小']
    ];
    for (const [t, title, axis, sign] of defs) {
      const b = el('button', 'solid-btn solid-padbtn', t); b.title = title; b.setAttribute('aria-label', title);
      let timer = 0, iv = 0, held = false;
      const stop = () => { clearTimeout(timer); clearInterval(iv); iv = 0; };
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch (_) {}
        held = false;
        if (axis != null) timer = setTimeout(() => { held = true; let last = performance.now();
          iv = setInterval(() => { const now = performance.now(); viewer.rotateScreen(axis, sign * RATE * (now - last) / 1000, false); last = now; }, 16); }, 300);
        else if (t === '⊞') timer = setTimeout(() => { held = true; viewer.reset(); }, 500);
        else { const k = t === '＋' ? 1 / 1.08 : 1.08; timer = setTimeout(() => { held = true; iv = setInterval(() => viewer.setZoom(viewer.getZoom() * k), 16); }, 300); }
      });
      const up = () => {
        const wasHeld = held; stop();
        if (wasHeld) { held = false; return; }
        if (axis != null) viewer.rotateScreen(axis, sign * H);
        else if (t === '⊞') viewer.snap();
        else viewer.setZoom(viewer.getZoom() * (t === '＋' ? 1 / 1.25 : 1.25));
      };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', () => { stop(); held = false; });
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      pad.appendChild(b);
    }
    stage.appendChild(pad);
    return pad;
  };

  /* ================= 層(レイヤー)の切り替え ================= */
  // state: { mode: 'all'|'single'|'upto', axis: 0|1|2, index, ghost }
  //  all    : 全部表示
  //  single : 選んだ1層だけ表示
  //  upto   : 0 層目から選んだ層まで表示(その先を切り取る = 断面)
  //  ghost  : 表示範囲のすぐ外の層を半透明で表示
  Solid.createLayerControl = function (container, o) {
    const st = { mode: o.mode || 'all', axis: o.axis != null ? o.axis : 2, index: 0, ghost: o.ghost != null ? o.ghost : true };
    let dims = o.dims.slice();
    const wrap = el('div', 'solid-row solid-layer');
    wrap.appendChild(el('span', 'solid-label', '層'));
    const modeSel = select([['all', '全体'], ['single', '単層'], ['upto', 'ここまで']], st.mode, 'solid-sel');
    modeSel.title = '表示する層の範囲';
    const axisSel = select([['0', 'X'], ['1', 'Y'], ['2', 'Z']], String(st.axis), 'solid-sel');
    axisSel.title = '層を切る向き(盤面の軸)';
    const prev = el('button', 'solid-btn', '◀'); prev.title = '前の層 ( [ )';
    const range = document.createElement('input'); range.type = 'range'; range.min = 0; range.step = 1; range.className = 'solid-range';
    const next = el('button', 'solid-btn', '▶'); next.title = '次の層 ( ] )';
    const lab = el('span', 'solid-num', '');
    const gl = el('label', 'solid-check'); const gc = document.createElement('input'); gc.type = 'checkbox'; gc.checked = st.ghost;
    gl.appendChild(gc); gl.appendChild(document.createTextNode('前後を薄く'));
    [modeSel, axisSel, prev, range, next, lab, gl].forEach((x) => wrap.appendChild(x));
    container.appendChild(wrap);

    function sync(fire) {
      const n = dims[st.axis];
      st.index = Math.max(0, Math.min(n - 1, st.index));
      range.max = n - 1; range.value = st.index;
      const dis = st.mode === 'all';
      range.disabled = prev.disabled = next.disabled = dis;
      lab.textContent = dis ? '' : (st.index + 1) + '/' + n;
      modeSel.value = st.mode; axisSel.value = String(st.axis); gc.checked = st.ghost;
      if (fire !== false) o.onChange && o.onChange(st);
    }
    modeSel.onchange = () => { st.mode = modeSel.value; sync(); };
    axisSel.onchange = () => { st.axis = +axisSel.value; sync(); };
    range.oninput = () => { st.index = +range.value; sync(); };
    prev.onclick = () => { if (st.mode === 'all') st.mode = 'single'; st.index--; sync(); };
    next.onclick = () => { if (st.mode === 'all') st.mode = 'single'; st.index++; sync(); };
    gc.onchange = () => { st.ghost = gc.checked; sync(); };

    const api = {
      state: st, el: wrap,
      /** 2:表示 1:薄く表示 0:非表示 */
      vis(x, y, z) {
        if (st.mode === 'all') return 2;
        const c = st.axis === 0 ? x : st.axis === 1 ? y : z;
        if (st.mode === 'single') return c === st.index ? 2 : (st.ghost && Math.abs(c - st.index) === 1 ? 1 : 0);
        return c <= st.index ? 2 : (st.ghost && c === st.index + 1 ? 1 : 0);
      },
      setDims(d) { dims = d.slice(); sync(false); },
      step(k) { if (st.mode === 'all') st.mode = 'single'; st.index += k; sync(); },
      cycleAxis() { st.axis = (st.axis + 1) % 3; sync(); },
      cycleMode() { st.mode = { all: 'single', single: 'upto', upto: 'all' }[st.mode]; sync(); },
      set(p) { Object.assign(st, p); sync(); }
    };
    sync(false);
    return api;
  };

  /* 選択中の層を示す枠 */
  Solid.LayerFrame = function (parent) {
    const geo = new T.EdgesGeometry(new T.BoxGeometry(1, 1, 1));
    const line = new T.LineSegments(geo, new T.LineBasicMaterial({ color: 0xffd25a, transparent: true, opacity: 0.85 }));
    line.visible = false; parent.add(line);
    this.update = function (dims, st) {
      if (st.mode === 'all') { line.visible = false; return; }
      const lo = [0, 0, 0], hi = dims.slice();
      if (st.mode === 'single') { lo[st.axis] = st.index; hi[st.axis] = st.index + 1; } else { hi[st.axis] = st.index + 1; }
      line.visible = true;
      line.scale.set(hi[0] - lo[0] + 0.04, hi[1] - lo[1] + 0.04, hi[2] - lo[2] + 0.04);
      line.position.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
    };
    this.object = line;
  };

  /* キーボード: 回転と層の共通割り当て */
  Solid.bindCommonKeys = function (viewer, layer, extra) {
    const H = Math.PI / 2;
    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
      if (extra) { const r = extra(e); if (r === true) { e.preventDefault(); return; } if (r === false) return; } // true=処理済み false=共通キーも使わない
      const k = e.key;
      const map = {
        i: () => viewer.rotateScreen(0, -H), k: () => viewer.rotateScreen(0, H),
        j: () => viewer.rotateScreen(1, -H), l: () => viewer.rotateScreen(1, H),
        u: () => viewer.rotateScreen(2, H), o: () => viewer.rotateScreen(2, -H),
        p: () => viewer.snap(), '0': () => viewer.reset(),
        '+': () => viewer.setZoom(viewer.getZoom() / 1.25), '=': () => viewer.setZoom(viewer.getZoom() / 1.25),
        '-': () => viewer.setZoom(viewer.getZoom() * 1.25)
      };
      if (layer) Object.assign(map, { '[': () => layer.step(-1), ']': () => layer.step(1), '\\': () => layer.cycleAxis(), m: () => layer.cycleMode() });
      const f = map[k.toLowerCase ? k.toLowerCase() : k];
      if (f) { f(); e.preventDefault(); }
    });
  };

  /* ================= 小物 ================= */
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function select(opts, val, cls) {
    const s = el('select', cls);
    for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; s.appendChild(o); }
    s.value = val; return s;
  }
  Solid.el = el; Solid.select = select;

  Solid.textTexture = function (text, color, opt) {
    opt = opt || {};
    const s = opt.size || 128, c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d');
    if (opt.bg) { g.fillStyle = opt.bg; g.fillRect(0, 0, s, s); }
    if (opt.border) { g.strokeStyle = opt.border; g.lineWidth = s * 0.06; g.strokeRect(s * 0.03, s * 0.03, s * 0.94, s * 0.94); }
    g.font = 'bold ' + Math.round(s * (opt.scale || (text.length > 1 ? 0.52 : 0.7))) + 'px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (opt.outline !== false) { g.lineWidth = s * 0.08; g.strokeStyle = opt.outline || 'rgba(0,0,0,0.85)'; g.strokeText(text, s / 2, s * 0.54); }
    g.fillStyle = color; g.fillText(text, s / 2, s * 0.54);
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4; return t;
  };

  Solid.formatTime = (sec) => { sec = Math.floor(sec); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };

  /** 簡易ダイアログ(結果表示・説明) */
  Solid.dialog = function (html, buttons) {
    const bg = el('div', 'solid-dialog-bg'); const box = el('div', 'solid-dialog');
    box.innerHTML = html;
    const row = el('div', 'solid-dialog-btns');
    for (const [t, f] of buttons || [['閉じる']]) { const b = el('button', 'solid-btn solid-wide', t); b.onclick = () => { if (f) f(); bg.remove(); }; /* 先に f を呼ぶ(ダイアログ内の入力を読めるように) */ row.appendChild(b); }
    box.appendChild(row); bg.appendChild(box);
    bg.addEventListener('pointerdown', (e) => { if (e.target === bg) bg.remove(); });
    document.body.appendChild(bg);
    return bg;
  };

  window.Solid = Solid;
})();
