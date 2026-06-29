/* Furniture Fit Planner — general, browser-only.
 *
 * Coordinate model:
 *   - Calibration & furniture are stored in IMAGE PIXELS (natural resolution).
 *   - All real-world lengths are stored in a CANONICAL BASE UNIT = inches.
 *     pxPerBase = image-pixels per inch. Calibration unit and furniture unit
 *     are independent; both convert to/from inches behind the scenes.
 *   - Furniture is stored by CENTER (cx,cy) + unrotated size + rotation angle,
 *     so free rotation is just a CSS transform. Snapping uses the rotated
 *     axis-aligned bounding box (exact at 0/90/180/270, sensible otherwise).
 */
(() => {
  "use strict";

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const stage = $("stage"), scroller = $("scroller"), planImg = $("planImg");
  const furnLayer = $("furnLayer"), overlay = $("overlay"), banner = $("banner");
  const dropHint = $("dropHint"), emptyState = $("emptyState"), emptyUploadBtn = $("emptyUploadBtn");

  const fileInput = $("fileInput"), uploadBtn = $("uploadBtn"), changeImgBtn = $("changeImgBtn");
  const calUnit = $("calUnit"), calibrateBtn = $("calibrateBtn"), scaleStatus = $("scaleStatus");
  const scaleCard = $("scaleCard"), imageBody = $("imageBody"), scaleBody = $("scaleBody"), scaleSummary = $("scaleSummary"), scaleEdit = $("scaleEdit");

  const fName = $("fName"), fShape = $("fShape"), fWidth = $("fWidth"), fDepth = $("fDepth");
  const furnUnit = $("furnUnit"), fColor = $("fColor"), addBtn = $("addBtn"), addHint = $("addHint");
  const furnListEl = $("furnList");
  const optWallSnap = $("optWallSnap"), optFreeRotate = $("optFreeRotate");
  const resetBtn = $("resetBtn");

  const zoomLabel = $("zoomLabel"), zoomIn = $("zoomIn"), zoomOut = $("zoomOut"), zoomFit = $("zoomFit");

  // ---------- Units ----------
  const UNIT_TO_IN = { in: 1, ft: 12, cm: 1 / 2.54, m: 100 / 2.54, mm: 0.1 / 2.54 };
  const toBase = (v, u) => v * UNIT_TO_IN[u];          // -> inches
  const fromBase = (v, u) => v / UNIT_TO_IN[u];        // inches -> u

  // ---------- State ----------
  const LS_KEY = "furnplanner.v2";
  const IDB_DB = "furnplanner", IDB_STORE = "kv";
  let natW = 0, natH = 0, zoom = 1;
  let hasImage = false;            // an image has been loaded this session
  let pxPerBase = null;            // image px per inch
  let furniture = [];              // {id,name,shape,color,wBase,hBase,unit,cx,cy,rot}
  let selectedId = null;
  let calLine = null;
  let calibrating = false, calTmp = null;
  let wallData = null;
  let scaleFolded = false;
  let opts = { wallSnap: false, freeRotate: false };

  const SNAP_DIST = 14;            // image px

  // ---------- IndexedDB (stores uploaded image data URI; can be large) ----------
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(IDB_DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbSet(k, v) {
    try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction(IDB_STORE, "readwrite"); t.objectStore(IDB_STORE).put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch (e) {}
  }
  async function idbGet(k) {
    try { const db = await idb(); return await new Promise((res) => { const t = db.transaction(IDB_STORE, "readonly"); const rq = t.objectStore(IDB_STORE).get(k); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); }); } catch (e) { return null; }
  }
  async function idbDel(k) { try { const db = await idb(); db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).delete(k); } catch (e) {} }

  // ---------- Persistence (layout in localStorage) ----------
  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        pxPerBase, calUnit: calUnit.value, furnUnit: furnUnit.value,
        furniture, calLine, zoom, scaleFolded, opts
      }));
    } catch (e) {}
  }
  function loadLayout() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) {}
    if (!s) return null;
    pxPerBase = s.pxPerBase ?? null;
    if (s.calUnit) calUnit.value = s.calUnit;
    if (s.furnUnit) furnUnit.value = s.furnUnit;
    furniture = s.furniture || [];
    calLine = s.calLine || null;
    zoom = s.zoom || 1;
    scaleFolded = !!s.scaleFolded;
    if (s.opts) opts = Object.assign(opts, s.opts);
    return s;
  }

  // ---------- Image loading ----------
  // An image must be uploaded before anything else works — there is no default.
  function loadImageSrc(src) {
    planImg.onload = () => {
      natW = planImg.naturalWidth; natH = planImg.naturalHeight;
      hasImage = true;
      stage.classList.remove("empty");
      buildWallBuffer();
      fitToView(true);
      render(); updateScaleUI(); renderList();
    };
    planImg.onerror = () => { hasImage = false; stage.classList.add("empty"); };
    planImg.src = src;
  }

  uploadBtn.addEventListener("click", () => fileInput.click());
  emptyUploadBtn.addEventListener("click", () => fileInput.click());
  changeImgBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); fileInput.value = ""; });

  function handleFile(file) {
    if (!file.type.startsWith("image/")) { showBanner("That's not an image file."); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUri = reader.result;
      // New image => fresh scale & furniture (old scale meaningless on new plan).
      pxPerBase = null; calLine = null; furniture = []; selectedId = null;
      scaleFolded = false;
      await idbSet("image", dataUri);
      loadImageSrc(dataUri);
      save();
      showBanner("Image loaded — draw a scale line to calibrate.");
    };
    reader.readAsDataURL(file);
  }

  // drag & drop onto stage
  ["dragenter", "dragover"].forEach((ev) => stageWrapEvents(ev, (e) => { e.preventDefault(); dropHint.classList.remove("hidden"); }));
  ["dragleave", "drop"].forEach((ev) => stageWrapEvents(ev, (e) => { e.preventDefault(); if (ev === "dragleave" && e.relatedTarget) return; dropHint.classList.add("hidden"); }));
  function stageWrapEvents(ev, fn) { document.getElementById("stageWrap").addEventListener(ev, fn); }
  document.getElementById("stageWrap").addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0]; if (f) handleFile(f);
  });

  // ---------- Wall buffer ----------
  function buildWallBuffer() {
    try {
      const c = document.createElement("canvas");
      c.width = natW; c.height = natH;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(planImg, 0, 0);
      const img = ctx.getImageData(0, 0, natW, natH).data;
      const lum = new Uint8ClampedArray(natW * natH);
      for (let i = 0, p = 0; i < img.length; i += 4, p++)
        lum[p] = (img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114) | 0;
      wallData = { data: lum, W: natW, H: natH };
    } catch (e) { wallData = null; }  // tainted canvas (shouldn't happen for local files)
  }
  function isDark(x, y) {
    if (!wallData) return false;
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= wallData.W || y >= wallData.H) return false;
    return wallData.data[y * wallData.W + x] < 110;
  }
  function colScore(col, y0, y1) { let h = 0; for (let i = 0; i < 9; i++) if (isDark(col, y0 + (y1 - y0) * i / 8)) h++; return h / 9; }
  function rowScore(row, x0, x1) { let h = 0; for (let i = 0; i < 9; i++) if (isDark(x0 + (x1 - x0) * i / 8, row)) h++; return h / 9; }

  // ---------- Geometry ----------
  function clientToImage(cx, cy) {
    const r = stage.getBoundingClientRect();
    return { x: (cx - r.left) / zoom, y: (cy - r.top) / zoom };
  }
  // unrotated pixel size
  function pieceSize(f) { return { w: f.wBase * pxPerBase, h: f.hBase * pxPerBase }; }
  // half-extents of the rotated AABB
  function aabbHalf(w, h, rotDeg) {
    const a = rotDeg * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    return { hx: (w * c + h * s) / 2, hy: (w * s + h * c) / 2 };
  }
  // AABB top-left + size for a piece
  function aabb(f) {
    const { w, h } = pieceSize(f); const { hx, hy } = aabbHalf(w, h, f.rot);
    return { x: f.cx - hx, y: f.cy - hy, w: hx * 2, h: hy * 2, hx, hy };
  }

  // ---------- Snapping (operates on AABB; returns adjusted top-left) ----------
  function snapAABB(x, y, w, h, selfId, useWalls) {
    let bestX = null, bestXc = SNAP_DIST + .5; const tryX = (nx, c) => { if (c < bestXc) { bestXc = c; bestX = nx; } };
    let bestY = null, bestYc = SNAP_DIST + .5; const tryY = (ny, c) => { if (c < bestYc) { bestYc = c; bestY = ny; } };

    if (useWalls && wallData) {
      const y0 = y + 3, y1 = y + h - 3;
      for (let d = -SNAP_DIST; d <= SNAP_DIST; d++) {
        const cl = Math.round(x + d); if (colScore(cl, y0, y1) >= .55) tryX(cl, Math.abs(d));
        const cr = Math.round(x + w + d); if (colScore(cr, y0, y1) >= .55) tryX(cr - w, Math.abs(d));
      }
      const x0 = x + 3, x1 = x + w - 3;
      for (let d = -SNAP_DIST; d <= SNAP_DIST; d++) {
        const rt = Math.round(y + d); if (rowScore(rt, x0, x1) >= .55) tryY(rt, Math.abs(d));
        const rb = Math.round(y + h + d); if (rowScore(rb, x0, x1) >= .55) tryY(rb - h, Math.abs(d));
      }
    }
    for (const o of furniture) {
      if (o.id === selfId) continue;
      const ob = aabb(o);
      if (y < ob.y + ob.h + 4 && y + h > ob.y - 4) {
        [ob.x - w, ob.x + ob.w, ob.x, ob.x + ob.w - w].forEach((nx) => tryX(nx, Math.abs(nx - x)));
      }
      if (x < ob.x + ob.w + 4 && x + w > ob.x - 4) {
        [ob.y - h, ob.y + ob.h, ob.y, ob.y + ob.h - h].forEach((ny) => tryY(ny, Math.abs(ny - y)));
      }
    }
    return { x: bestX != null ? bestX : x, y: bestY != null ? bestY : y };
  }
  // snap a piece by its center, honoring options & alt-override
  function snapPiece(f, noSnap) {
    const b = aabb(f);
    if (noSnap) return;
    const useWalls = opts.wallSnap;
    if (!useWalls && furniture.length <= 1) return; // nothing to snap to
    const s = snapAABB(b.x, b.y, b.w, b.h, f.id, useWalls);
    f.cx = s.x + b.hx; f.cy = s.y + b.hy;
  }

  // ---------- Render ----------
  function render() {
    if (!natW) return;
    const w = natW * zoom, h = natH * zoom;
    stage.style.width = w + "px"; stage.style.height = h + "px";
    planImg.style.width = w + "px"; planImg.style.height = h + "px";
    overlay.setAttribute("viewBox", `0 0 ${natW} ${natH}`);
    overlay.style.width = w + "px"; overlay.style.height = h + "px";
    zoomLabel.textContent = Math.round(zoom * 100) + "%";
    // center when content is smaller than the viewport (req 7)
    stage.style.marginLeft = w < scroller.clientWidth ? ((scroller.clientWidth - w) / 2) + "px" : "0";
    stage.style.marginTop = h < scroller.clientHeight ? ((scroller.clientHeight - h) / 2) + "px" : "0";
    renderFurniture(); renderOverlay();
  }

  function renderFurniture() {
    furnLayer.innerHTML = "";
    if (pxPerBase == null) return;
    for (const f of furniture) {
      const { w, h } = pieceSize(f);
      const el = document.createElement("div");
      el.className = "furn" + (f.shape === "round" ? " round" : "") + (f.id === selectedId ? " selected" : "");
      el.dataset.id = f.id;
      el.style.left = (f.cx * zoom - w * zoom / 2) + "px";
      el.style.top = (f.cy * zoom - h * zoom / 2) + "px";
      el.style.width = (w * zoom) + "px";
      el.style.height = (h * zoom) + "px";
      el.style.transform = `rotate(${f.rot}deg)`;
      el.style.background = hexToRgba(f.color, .5);
      el.style.borderColor = f.color;
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = `${f.name}\n${fmt(f.wBase, f.unit)}×${fmt(f.hBase, f.unit)} ${f.unit}`;
      el.appendChild(lbl);
      if (f.id === selectedId && opts.freeRotate) {
        el.insertAdjacentHTML("beforeend", '<div class="rot-stem"></div><div class="rot-handle" data-rot="1"></div>');
      }
      furnLayer.appendChild(el);
    }
  }

  function renderOverlay() {
    let svg = "";
    const line = calTmp || calLine;
    if (line) {
      svg += `<line x1="${line.x1}" y1="${line.y1}" x2="${line.x2}" y2="${line.y2}" stroke="#ff9a3c" stroke-width="2" ${calTmp ? 'stroke-dasharray="5,4"' : ""} vector-effect="non-scaling-stroke"/>`;
      if (!calTmp) svg += dot(line.x1, line.y1) + dot(line.x2, line.y2);
    }
    overlay.innerHTML = svg;
  }
  const dot = (x, y) => `<circle cx="${x}" cy="${y}" r="4" fill="#ff9a3c" vector-effect="non-scaling-stroke"/>`;

  function renderList() {
    furnListEl.innerHTML = "";
    for (const f of furniture) {
      const li = document.createElement("li");
      li.className = "furn-item" + (f.id === selectedId ? " selected" : "");
      li.dataset.id = f.id;
      li.innerHTML =
        `<span class="furn-swatch ${f.shape === "round" ? "round" : ""}" style="background:${f.color}"></span>` +
        `<span class="nm">${escapeHtml(f.name)}</span>` +
        `<span class="sz">${fmt(f.wBase, f.unit)}×${fmt(f.hBase, f.unit)}${f.unit}${f.rot ? " ↻" + Math.round(f.rot) + "°" : ""}</span>` +
        `<span class="del" title="Delete">✕</span>`;
      furnListEl.appendChild(li);
    }
  }

  // ---------- Scale UI + folding (req 5) ----------
  function updateScaleUI() {
    const calibrated = pxPerBase != null;
    addBtn.disabled = !calibrated;
    addHint.textContent = calibrated ? "" : "Set the scale first to add furniture.";

    if (calibrated) {
      scaleStatus.classList.add("ok");
      const u = calUnit.value;
      const ppu = pxPerBase * UNIT_TO_IN[u]; // px per cal-unit
      scaleStatus.textContent = `Calibrated. ${ppu.toFixed(2)} px = 1 ${u}.`;
      scaleSummary.innerHTML = `<b>Scale:</b> ${ppu.toFixed(2)} px / ${u} &nbsp;and&nbsp; image ≈ <b>${fmt(fromBase(natW / pxPerBase, u), u)} × ${fmt(fromBase(natH / pxPerBase, u), u)} ${u}</b>`;
    } else {
      scaleStatus.classList.remove("ok");
      scaleStatus.textContent = "Not calibrated yet.";
    }
    applyFold();
  }
  // Three states in the merged card:
  //   no image          → show upload step only
  //   image, no scale   → show upload step + calibration step
  //   calibrated+folded → show one-line summary, with Edit to reopen
  function applyFold() {
    const calibrated = pxPerBase != null;
    emptyState.classList.toggle("hidden", hasImage);
    if (!hasImage) {
      imageBody.hidden = false; scaleBody.hidden = true; scaleSummary.hidden = true;
      scaleEdit.hidden = true;
      return;
    }
    scaleEdit.hidden = !calibrated;
    if (calibrated && scaleFolded) {
      imageBody.hidden = true; scaleBody.hidden = true; scaleSummary.hidden = false;
      scaleEdit.textContent = "Edit";
    } else {
      // upload step stays available so the user can replace the image
      imageBody.hidden = true;            // (Replace button lives in scaleBody)
      scaleBody.hidden = false; scaleSummary.hidden = true;
      scaleEdit.textContent = calibrated ? "Done" : "Edit";
    }
  }
  scaleEdit.addEventListener("click", () => { scaleFolded = !scaleFolded; applyFold(); save(); });

  // ---------- Calibration ----------
  calibrateBtn.addEventListener("click", () => {
    if (!hasImage) { showBanner("Upload a floor plan first."); return; }
    calibrating = !calibrating; calTmp = null;
    stage.classList.toggle("calibrating", calibrating);
    calibrateBtn.classList.toggle("slds-button_brand", !calibrating);
    calibrateBtn.textContent = calibrating ? "Click & Drag on the Plan…" : "Draw Scale Line";
    showBanner(calibrating ? "Drag a line over a known length, then enter how long it is." : null);
  });
  function finishCalibration() {
    const { x1, y1, x2, y2 } = calTmp; const lenPx = Math.hypot(x2 - x1, y2 - y1); calTmp = null;
    if (lenPx < 5) { showBanner("Line too short — try again."); renderOverlay(); return; }
    const u = calUnit.value;
    const ans = prompt(`That line is ${lenPx.toFixed(1)} px.\nHow long is it in real life? (${u})`);
    if (ans == null) { renderOverlay(); return; }
    const real = parseFloat(ans);
    if (!(real > 0)) { showBanner("Invalid distance."); renderOverlay(); return; }
    pxPerBase = lenPx / toBase(real, u);
    calLine = { x1, y1, x2, y2 };
    calibrating = false; stage.classList.remove("calibrating");
    calibrateBtn.textContent = "Draw Scale Line"; calibrateBtn.classList.add("slds-button_brand");
    scaleFolded = true; showBanner(null);
    updateScaleUI(); render(); save();
  }

  // ---------- Pointer (calibrate / drag / rotate / pan) ----------
  let mode = null, dragState = null;
  stage.addEventListener("pointerdown", (e) => {
    if (calibrating) {
      const p = clientToImage(e.clientX, e.clientY);
      calTmp = { x1: p.x, y1: p.y, x2: p.x, y2: p.y }; mode = "cal";
      stage.setPointerCapture(e.pointerId); e.preventDefault(); return;
    }
    if (e.target.classList.contains("rot-handle")) {
      const f = furniture.find((x) => x.id === selectedId);
      if (f) { mode = "rotate"; dragState = { id: f.id }; stage.setPointerCapture(e.pointerId); e.preventDefault(); }
      return;
    }
    const furnEl = e.target.closest(".furn");
    if (furnEl) {
      const f = furniture.find((x) => x.id === furnEl.dataset.id);
      selectedId = f.id;
      const p = clientToImage(e.clientX, e.clientY);
      dragState = { id: f.id, dx: p.x - f.cx, dy: p.y - f.cy };
      mode = "drag"; furnEl.classList.add("dragging");
      stage.setPointerCapture(e.pointerId);
      renderFurniture(); renderList(); e.preventDefault(); return;
    }
    selectedId = null; renderFurniture(); renderList();
    mode = "pan";
    dragState = { sx: scroller.scrollLeft, sy: scroller.scrollTop, cx: e.clientX, cy: e.clientY };
    stage.setPointerCapture(e.pointerId);
  });

  stage.addEventListener("pointermove", (e) => {
    if (mode === "cal" && calTmp) {
      const p = clientToImage(e.clientX, e.clientY); calTmp.x2 = p.x; calTmp.y2 = p.y; renderOverlay();
    } else if (mode === "drag" && dragState) {
      const f = furniture.find((x) => x.id === dragState.id); if (!f) return;
      const p = clientToImage(e.clientX, e.clientY);
      f.cx = p.x - dragState.dx; f.cy = p.y - dragState.dy;
      snapPiece(f, e.altKey);
      renderFurniture();
    } else if (mode === "rotate" && dragState) {
      const f = furniture.find((x) => x.id === dragState.id); if (!f) return;
      const p = clientToImage(e.clientX, e.clientY);
      let ang = Math.atan2(p.y - f.cy, p.x - f.cx) * 180 / Math.PI + 90;
      if (e.shiftKey) ang = Math.round(ang / 15) * 15;
      f.rot = ((ang % 360) + 360) % 360;
      renderFurniture();
    } else if (mode === "pan" && dragState) {
      scroller.scrollLeft = dragState.sx - (e.clientX - dragState.cx);
      scroller.scrollTop = dragState.sy - (e.clientY - dragState.cy);
    }
  });

  stage.addEventListener("pointerup", () => {
    if (mode === "cal" && calTmp) finishCalibration();
    else if (mode === "drag") { const el = furnLayer.querySelector(".dragging"); if (el) el.classList.remove("dragging"); save(); }
    else if (mode === "rotate") { snapPiece(furniture.find((x) => x.id === dragState.id), false); renderFurniture(); renderList(); save(); }
    mode = null; dragState = null;
  });

  // ---------- Add furniture ----------
  fShape.addEventListener("change", () => {
    const round = fShape.value === "round";
    document.querySelector(".dimW").textContent = round ? "Width (Ø x)" : "Width";
    document.querySelector(".dimD").textContent = round ? "Height (Ø y)" : "Depth";
  });
  addBtn.addEventListener("click", () => {
    if (pxPerBase == null) return;
    const w = parseFloat(fWidth.value), h = parseFloat(fDepth.value);
    if (!(w > 0) || !(h > 0)) { showBanner("Enter a valid width and depth."); return; }
    const u = furnUnit.value;
    const cx = (scroller.scrollLeft + scroller.clientWidth / 2) / zoom;
    const cy = (scroller.scrollTop + scroller.clientHeight / 2) / zoom;
    const f = {
      id: "f" + Date.now() + Math.round(performance.now()),
      name: (fName.value || "Item").trim(), shape: fShape.value, color: fColor.value,
      wBase: toBase(w, u), hBase: toBase(h, u), unit: u, cx, cy, rot: 0
    };
    furniture.push(f); selectedId = f.id; fName.value = "";
    render(); renderList(); save();
  });
  [fName, fWidth, fDepth].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); }));

  // ---------- List ----------
  furnListEl.addEventListener("click", (e) => {
    const li = e.target.closest(".furn-item"); if (!li) return;
    const id = li.dataset.id;
    if (e.target.classList.contains("del")) {
      furniture = furniture.filter((f) => f.id !== id);
      if (selectedId === id) selectedId = null;
      render(); renderList(); save(); return;
    }
    selectedId = id; renderFurniture(); renderList(); scrollPieceIntoView(id);
  });
  function scrollPieceIntoView(id) {
    const f = furniture.find((x) => x.id === id); if (!f) return;
    scroller.scrollTo({ left: f.cx * zoom - scroller.clientWidth / 2, top: f.cy * zoom - scroller.clientHeight / 2, behavior: "smooth" });
  }

  // ---------- Options ----------
  optWallSnap.checked = opts.wallSnap; optFreeRotate.checked = opts.freeRotate;
  optWallSnap.addEventListener("change", () => { opts.wallSnap = optWallSnap.checked; save(); });
  optFreeRotate.addEventListener("change", () => {
    opts.freeRotate = optFreeRotate.checked;
    // leaving free-rotate mode: snap every piece back to the nearest 90°
    if (!opts.freeRotate) {
      for (const f of furniture) {
        const rounded = (Math.round(f.rot / 90) * 90) % 360;
        if (rounded !== f.rot) { f.rot = rounded; snapPiece(f, false); }
      }
      render(); renderList();
    } else {
      renderFurniture();
    }
    save();
  });

  // ---------- Keyboard ----------
  window.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (!selectedId) return;
    const f = furniture.find((x) => x.id === selectedId); if (!f) return;
    if (e.key === "r" || e.key === "R") {
      f.rot = (((f.rot + (e.shiftKey ? -90 : 90)) % 360) + 360) % 360;
      snapPiece(f, false); render(); renderList(); save(); e.preventDefault();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      furniture = furniture.filter((x) => x.id !== f.id); selectedId = null;
      render(); renderList(); save(); e.preventDefault();
    } else if (e.key.startsWith("Arrow")) {
      const step = (e.shiftKey ? 10 : 1) / zoom;
      if (e.key === "ArrowLeft") f.cx -= step;
      if (e.key === "ArrowRight") f.cx += step;
      if (e.key === "ArrowUp") f.cy -= step;
      if (e.key === "ArrowDown") f.cy += step;
      renderFurniture(); save(); e.preventDefault();
    }
  });

  // ---------- Zoom / pan ----------
  function setZoom(z, centerClient) {
    const old = zoom; z = Math.max(0.05, Math.min(8, z)); if (z === old) return;
    const rect = scroller.getBoundingClientRect();
    const px = centerClient ? centerClient.x - rect.left : scroller.clientWidth / 2;
    const py = centerClient ? centerClient.y - rect.top : scroller.clientHeight / 2;
    const ix = (scroller.scrollLeft + px) / old, iy = (scroller.scrollTop + py) / old;
    zoom = z; render();
    scroller.scrollLeft = ix * zoom - px; scroller.scrollTop = iy * zoom - py; save();
  }
  zoomIn.addEventListener("click", () => setZoom(zoom * 1.2));
  zoomOut.addEventListener("click", () => setZoom(zoom / 1.2));
  zoomFit.addEventListener("click", () => fitToView());
  scroller.addEventListener("wheel", (e) => { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), { x: e.clientX, y: e.clientY }); }, { passive: false });

  // Fit AND center (req 7). render() applies centering margins; here we also
  // center the scroll so larger-than-viewport images frame their middle.
  function fitToView(initial) {
    if (!natW) return;
    const pad = 32;
    zoom = Math.max(0.05, Math.min((scroller.clientWidth - pad) / natW, (scroller.clientHeight - pad) / natH));
    render();
    const w = natW * zoom, h = natH * zoom;
    scroller.scrollLeft = Math.max(0, (w - scroller.clientWidth) / 2);
    scroller.scrollTop = Math.max(0, (h - scroller.clientHeight) / 2);
    if (!initial) save();
  }

  window.addEventListener("resize", () => { if (natW) render(); });

  // ---------- Reset ----------
  resetBtn.addEventListener("click", async () => {
    if (!confirm("Clear everything (floor plan, scale, furniture)?")) return;
    furniture = []; selectedId = null; localStorage.removeItem(LS_KEY); await idbDel("image");
    pxPerBase = null; calLine = null; hasImage = false; natW = natH = 0;
    calUnit.value = "in"; furnUnit.value = "in"; scaleFolded = false;
    opts = { wallSnap: false, freeRotate: false };
    optWallSnap.checked = false; optFreeRotate.checked = false;
    planImg.removeAttribute("src"); stage.classList.add("empty");
    overlay.innerHTML = ""; furnLayer.innerHTML = "";
    updateScaleUI(); renderList(); save();
  });

  // re-label scale when the calibration unit changes (conversion is automatic
  // because storage is in inches; this only re-displays).
  calUnit.addEventListener("change", () => { if (pxPerBase != null) updateScaleUI(); save(); });

  // ---------- Helpers ----------
  let bannerTimer = null;
  function showBanner(msg) {
    clearTimeout(bannerTimer);
    if (!msg) { banner.classList.add("hidden"); return; }
    banner.textContent = msg; banner.classList.remove("hidden");
    bannerTimer = setTimeout(() => banner.classList.add("hidden"), 4200);
  }
  function fmt(baseVal, u) { return Math.round(fromBase(baseVal, u) * 10) / 10; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function hexToRgba(hex, a) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : `rgba(27,150,255,${a})`;
  }

  // ---------- Boot ----------
  // No default plan: restore a previously uploaded image if one exists,
  // otherwise show the empty state and require an upload.
  (async function boot() {
    loadLayout();
    optWallSnap.checked = opts.wallSnap; optFreeRotate.checked = opts.freeRotate;
    const savedImg = await idbGet("image");
    if (savedImg) {
      loadImageSrc(savedImg);
    } else {
      // nothing to show yet — discard any stale scale/furniture and prompt for upload
      pxPerBase = null; calLine = null; furniture = []; hasImage = false;
      localStorage.removeItem(LS_KEY);
      stage.classList.add("empty");
      updateScaleUI(); renderList();
    }
  })();
})();
