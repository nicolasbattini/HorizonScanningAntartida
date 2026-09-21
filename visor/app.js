/*
 * Visor de capas ráster — motor de mapa propio, sin librerías externas.
 * Mapa base en teselas (Web Mercator) + capa ráster dibujada celda a celda
 * a partir del GeoTIFF, con lectura del valor de cada celda.
 */
(function () {
  'use strict';

  const CFG = window.VISOR_CONFIG;
  const TILE = 256;
  const MAXZ = 11;

  const $ = (s) => document.querySelector(s);
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      for (const k in props) {
        if (k === 'class') n.className = props[k];
        else if (k === 'text') n.textContent = props[k];
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), props[k]);
        else n.setAttribute(k, props[k]);
      }
    }
    for (const c of kids) if (c != null) n.append(c);
    return n;
  }

  /* ---------- paletas ---------- */

  const PALETAS = {
    viridis: ['#440154', '#472d7b', '#3b528b', '#2c728e', '#21918c', '#28ae80', '#5ec962', '#addc30', '#fde725'],
    magma: ['#000004', '#140e36', '#3b0f70', '#641a80', '#8c2981', '#b73779', '#de4968', '#f7705c', '#fe9f6d', '#fecf92', '#fcfdbf'],
    mako: ['#0b0405', '#382a54', '#395d9c', '#3497a9', '#60ceac', '#def5e5'],
    cividis: ['#00204d', '#31446b', '#666970', '#958f78', '#cbba69', '#ffea46']
  };

  function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function buildLut(stops) {
    const rgb = stops.map(hexToRgb);
    const lut = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      const t = (i / 255) * (rgb.length - 1);
      const k = Math.min(rgb.length - 2, Math.floor(t));
      const f = t - k;
      const r = Math.round(rgb[k][0] + (rgb[k + 1][0] - rgb[k][0]) * f);
      const g = Math.round(rgb[k][1] + (rgb[k + 1][1] - rgb[k][1]) * f);
      const b = Math.round(rgb[k][2] + (rgb[k + 1][2] - rgb[k][2]) * f);
      lut[i] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0; // ABGR (little-endian)
    }
    return lut;
  }

  /* ---------- mapas base ---------- */

  const CARTO = 'https://{s}.basemaps.cartocdn.com/';
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const BASES = {
    claro: {
      nombre: 'Claro (CARTO)', fondo: '#e9edf1',
      capa: { url: CARTO + 'light_nolabels/{z}/{x}/{y}{r}.png', sub: 'abcd', max: 20 },
      etiquetas: { url: CARTO + 'light_only_labels/{z}/{x}/{y}{r}.png', sub: 'abcd', max: 20 },
      atrib: '© OpenStreetMap contributors © CARTO'
    },
    oscuro: {
      nombre: 'Oscuro (CARTO)', fondo: '#1c2127',
      capa: { url: CARTO + 'dark_nolabels/{z}/{x}/{y}{r}.png', sub: 'abcd', max: 20 },
      etiquetas: { url: CARTO + 'dark_only_labels/{z}/{x}/{y}{r}.png', sub: 'abcd', max: 20 },
      atrib: '© OpenStreetMap contributors © CARTO'
    },
    oceano: {
      nombre: 'Océano (Esri)', fondo: '#a8c3d6',
      capa: { url: ESRI + 'Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}', max: 10 },
      etiquetas: { url: ESRI + 'Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}', max: 10 },
      atrib: 'Esri, GEBCO, NOAA, National Geographic, DeLorme, HERE, Geonames.org y otros'
    },
    satelite: {
      nombre: 'Satélite (Esri)', fondo: '#22282e',
      capa: { url: ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', max: 18 },
      etiquetas: null,
      atrib: 'Esri, Maxar, Earthstar Geographics y la comunidad de usuarios de GIS'
    }
  };

  /* ---------- estado ---------- */

  const S = {
    cx: 0.5, cy: 0.5, zoom: 3, W: 1, H: 1,
    dpr: Math.min(2, window.devicePixelRatio || 1),
    activa: null, opac: 0.85, base: 'claro',
    sel: null, interacting: false
  };

  const capas = CFG.capas.map((c) => Object.assign({}, c, { raster: null, error: null, progreso: 0 }));
  const capaById = (id) => capas.find((c) => c.id === id);

  const nfCache = {};
  function nf(d) {
    return nfCache[d] || (nfCache[d] = new Intl.NumberFormat('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d }));
  }
  const fmtVal = (v, c) => nf(c.decimales == null ? 2 : c.decimales).format(v) + (c.unidad ? ' ' + c.unidad : '');
  const fmtCoord = (lat, lng) =>
    nf(4).format(Math.abs(lat)) + '° ' + (lat < 0 ? 'S' : 'N') + ', ' +
    nf(4).format(Math.abs(lng)) + '° ' + (lng < 0 ? 'O' : 'E');

  /* ---------- geometría Web Mercator ---------- */

  const lonToMx = (lon) => (lon + 180) / 360;
  const latToMy = (lat) => {
    const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  const mxToLon = (mx) => mx * 360 - 180;
  const myToLat = (my) => Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180 / Math.PI;
  const worldSize = () => TILE * Math.pow(2, S.zoom);
  const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

  function screenToGeo(px, py) {
    const Sz = worldSize();
    const mx = S.cx + (px - S.W / 2) / Sz;
    const my = S.cy + (py - S.H / 2) / Sz;
    return { lon: wrapLon(mxToLon(mx)), lat: myToLat(my), inside: my >= 0 && my <= 1 };
  }
  function geoToScreen(lon, lat) {
    const Sz = worldSize();
    let dxm = lonToMx(lon) - S.cx;
    dxm -= Math.round(dxm);
    return { x: S.W / 2 + dxm * Sz, y: S.H / 2 + (latToMy(lat) - S.cy) * Sz };
  }

  function clampView() {
    const minZ = Math.log2(Math.max(S.H, TILE) / TILE);
    S.zoom = Math.max(minZ, Math.min(MAXZ, S.zoom));
    const half = S.H / 2 / worldSize();
    S.cy = half >= 0.5 ? 0.5 : Math.max(half, Math.min(1 - half, S.cy));
    S.cx = ((S.cx % 1) + 1) % 1;
  }

  function zoomAt(px, py, z) {
    const Sz = worldSize();
    const mx = S.cx + (px - S.W / 2) / Sz;
    const my = S.cy + (py - S.H / 2) / Sz;
    S.zoom = z;
    clampView();
    const Sz2 = worldSize();
    S.cx = mx - (px - S.W / 2) / Sz2;
    S.cy = my - (py - S.H / 2) / Sz2;
    clampView();
  }

  function panelInsets() {
    const p = $('#panel');
    if (S.W > 720) return { l: p.offsetWidth + 24, b: 0 };
    return { l: 0, b: Math.min(p.offsetHeight, S.H * 0.46) };
  }

  function fitBounds(b) {
    const [w, s, e, n] = b;
    const ins = panelInsets();
    const availW = Math.max(200, S.W - ins.l), availH = Math.max(200, S.H - ins.b);
    const dmx = lonToMx(e) - lonToMx(w), dmy = latToMy(s) - latToMy(n);
    S.zoom = Math.min(Math.log2(availW / (TILE * dmx)), Math.log2(availH / (TILE * dmy))) - 0.1;
    clampView();
    const Sz = worldSize();
    S.cx = (lonToMx(w) + lonToMx(e)) / 2 - ins.l / 2 / Sz;
    S.cy = (latToMy(s) + latToMy(n)) / 2 + ins.b / 2 / Sz;
    clampView();
  }

  /* ---------- lienzos ---------- */

  const map = $('#map');
  const cBase = $('#c-base'), cRas = $('#c-ras'), cLab = $('#c-lab'), cOv = $('#c-ov');

  function resize() {
    S.W = map.clientWidth; S.H = map.clientHeight;
    S.dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [cBase, cLab, cOv]) {
      c.width = Math.round(S.W * S.dpr);
      c.height = Math.round(S.H * S.dpr);
    }
    clampView();
    requestDraw();
  }

  let raf = 0;
  function requestDraw() {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }

  function draw() {
    const b = BASES[S.base];
    map.style.background = b.fondo;
    drawTiles(cBase, b.capa);
    drawTiles(cLab, b.etiquetas);
    drawRaster();
    drawOverlay();
  }

  /* ---------- teselas ---------- */

  const tileCache = new Map();
  function getTile(url) {
    let t = tileCache.get(url);
    if (t) return t;
    t = { img: new Image(), ok: false };
    t.img.onload = () => { t.ok = true; requestDraw(); };
    t.img.onerror = () => { t.err = true; };
    t.img.src = url;
    tileCache.set(url, t);
    if (tileCache.size > 700) tileCache.delete(tileCache.keys().next().value);
    return t;
  }

  function tileUrl(def, z, x, y) {
    return def.url
      .replace('{s}', def.sub ? def.sub[(x + y) % def.sub.length] : '')
      .replace('{z}', z).replace('{x}', x).replace('{y}', y)
      .replace('{r}', S.dpr > 1.4 && def.sub ? '@2x' : '');
  }

  function drawTiles(canvas, def) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.clearRect(0, 0, S.W, S.H);
    if (!def) return;
    const Sz = worldSize();
    const z = Math.max(0, Math.min(def.max, Math.round(S.zoom)));
    const n = Math.pow(2, z);
    const ts = Sz / n;
    const left = S.cx * Sz - S.W / 2, top = S.cy * Sz - S.H / 2;
    const tx0 = Math.floor(left / ts), tx1 = Math.floor((left + S.W) / ts);
    const ty0 = Math.max(0, Math.floor(top / ts)), ty1 = Math.min(n - 1, Math.floor((top + S.H) / ts));
    const px = Math.ceil(ts) + 1;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = getTile(tileUrl(def, z, ((tx % n) + n) % n, ty));
        if (t.ok) ctx.drawImage(t.img, Math.floor(tx * ts - left), Math.floor(ty * ts - top), px, px);
      }
    }
  }

  /* ---------- ráster ---------- */

  let imgBuf = null;

  function drawRaster() {
    const ctx = cRas.getContext('2d');
    const capa = S.activa;
    const r = capa && capa.raster;
    if (!r) { ctx.clearRect(0, 0, cRas.width, cRas.height); return; }

    const rs = S.interacting ? 1 : S.dpr;
    const w = Math.round(S.W * rs), h = Math.round(S.H * rs);
    if (cRas.width !== w || cRas.height !== h) { cRas.width = w; cRas.height = h; }
    if (!imgBuf || imgBuf.width !== w || imgBuf.height !== h) imgBuf = ctx.createImageData(w, h);
    const px = new Uint32Array(imgBuf.data.buffer);
    px.fill(0);

    const Sz = worldSize();
    const cols = new Int32Array(w);
    for (let x = 0; x < w; x++) {
      const mx = S.cx + ((x + 0.5) / rs - S.W / 2) / Sz;
      const lon = wrapLon(mxToLon(mx));
      const c = Math.floor((lon - r.x0) / r.dx);
      cols[x] = c >= 0 && c < r.width ? c : -1;
    }
    const lut = capa.lut;
    const mn = capa.dom[0];
    const k = 255 / (capa.dom[1] - capa.dom[0] || 1);
    const data = r.data, W = r.width;
    for (let y = 0; y < h; y++) {
      const my = S.cy + ((y + 0.5) / rs - S.H / 2) / Sz;
      if (my < 0 || my > 1) continue;
      const row = Math.floor((r.y0 - myToLat(my)) / r.dy);
      if (row < 0 || row >= r.height) continue;
      const rb = row * W, ob = y * w;
      for (let x = 0; x < w; x++) {
        const c = cols[x];
        if (c < 0) continue;
        const v = data[rb + c];
        if (v !== v) continue;
        const i = ((v - mn) * k) | 0;
        px[ob + x] = lut[i < 0 ? 0 : i > 255 ? 255 : i];
      }
    }
    ctx.putImageData(imgBuf, 0, 0);
    cRas.style.opacity = S.opac;
  }

  function valueAt(r, lon, lat) {
    const col = Math.floor((wrapLon(lon) - r.x0) / r.dx);
    const row = Math.floor((r.y0 - lat) / r.dy);
    if (col < 0 || col >= r.width || row < 0 || row >= r.height) return { fuera: true };
    const v = r.data[row * r.width + col];
    return { col, row, v: v !== v ? null : v };
  }

  /* ---------- selección de celda ---------- */

  function drawOverlay() {
    const ctx = cOv.getContext('2d');
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.clearRect(0, 0, S.W, S.H);
    if (!S.sel) return;
    const r = S.activa && S.activa.raster;
    let hit = r && valueAt(r, S.sel.lon, S.sel.lat);
    if (hit && !hit.fuera) {
      const lon0 = r.x0 + hit.col * r.dx, lat0 = r.y0 - hit.row * r.dy;
      const a = geoToScreen(lon0, lat0), b = geoToScreen(lon0 + r.dx, lat0 - r.dy);
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const w = Math.max(6, Math.abs(b.x - a.x)), h = Math.max(6, Math.abs(b.y - a.y));
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.strokeRect(x, y, w, h);
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.strokeRect(x, y, w, h);
    } else {
      const p = geoToScreen(S.sel.lon, S.sel.lat);
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, 7);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.stroke();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
  }

  function selectGeo(lon, lat) {
    S.sel = { lon: wrapLon(lon), lat };
    updateInfo();
    drawOverlay();
    scheduleHash();
    if (S.W <= 720 && !$('#panel').classList.contains('min')) $('#info').scrollIntoView({ block: 'nearest' });
  }

  const info = $('#info-cuerpo');
  let lastCopy = '';

  function updateInfo() {
    info.textContent = '';
    if (!S.sel) {
      info.append(el('p', { class: 'vacio', text: 'Todavía no seleccionaste ninguna celda. Hacé clic sobre el mapa.' }));
      return;
    }
    const { lon, lat } = S.sel;
    const tbody = el('tbody');
    const lines = [fmtCoord(lat, lon)];
    let celda = '';
    for (const c of capas) {
      let txt;
      if (c.error) txt = 'error al cargar';
      else if (!c.raster) txt = 'cargando…';
      else {
        const h = valueAt(c.raster, lon, lat);
        if (h.fuera || h.v === null) txt = 'sin dato';
        else txt = fmtVal(h.v, c);
        if (c === S.activa && !h.fuera) celda = 'Celda fila ' + h.row + ', columna ' + h.col + ' de la capa activa';
      }
      lines.push(c.nombre + ': ' + txt);
      tbody.append(el('tr', { class: c === S.activa ? 'act' : '' },
        el('th', { scope: 'row', text: c.nombre }),
        el('td', { class: txt === 'sin dato' || /cargando|error/.test(txt) ? 'nd' : '', text: txt })));
    }
    lastCopy = lines.join('\n');
    info.append(
      el('p', { class: 'coords', text: fmtCoord(lat, lon) }),
      el('table', null, tbody),
      celda ? el('p', { class: 'celda', text: celda }) : null,
      el('button', { class: 'btn', type: 'button', text: 'Copiar valores', onclick: copiar })
    );
  }

  function copiar(ev) {
    const b = ev.currentTarget;
    const ok = () => { b.textContent = 'Copiado'; setTimeout(() => { b.textContent = 'Copiar valores'; }, 1400); };
    try { navigator.clipboard.writeText(lastCopy).then(ok, () => {}); } catch (e) { /* sin portapapeles */ }
  }

  /* ---------- panel: capas, leyenda, base ---------- */

  function buildPanel() {
    document.title = CFG.titulo;
    $('#titulo').textContent = CFG.titulo;
    $('#subtitulo').textContent = CFG.subtitulo || '';

    const list = $('#lista-capas');
    for (const c of capas) {
      c.estado = el('span', { class: 'estado', 'aria-live': 'polite', text: '0 %' });
      list.append(el('label', { class: 'capa' },
        el('input', { type: 'radio', name: 'capa', value: c.id, onchange: () => setActiva(c) }),
        el('span', { class: 'txt' }, el('b', { text: c.nombre }), el('small', { text: c.descripcion || '' })),
        c.estado));
    }

    const sel = $('#sel-base');
    for (const id in BASES) sel.append(el('option', { value: id, text: BASES[id].nombre }));
    sel.value = S.base;
    sel.addEventListener('change', () => { S.base = sel.value; setAtrib(); requestDraw(); scheduleHash(); });

    $('#opacidad').addEventListener('input', (e) => {
      S.opac = e.target.value / 100;
      cRas.style.opacity = S.opac;
    });

    $('#min').addEventListener('click', () => $('#panel').classList.toggle('min'));
    setAtrib();
  }

  function setAtrib() {
    $('#atrib').textContent = 'Mapa base: ' + BASES[S.base].atrib + (CFG.creditoDatos ? ' · ' + CFG.creditoDatos : '');
  }

  function setActiva(c) {
    S.activa = c;
    for (const inp of document.querySelectorAll('input[name=capa]')) inp.checked = inp.value === c.id;
    drawLegend();
    updateInfo();
    requestDraw();
    scheduleHash();
  }

  function drawLegend() {
    const c = S.activa, box = $('#leyenda');
    box.textContent = '';
    if (!c || !c.raster) {
      box.append(el('p', { class: 'vacio', text: c && c.error ? 'No se pudo cargar esta capa.' : 'Cargando capa…' }));
      return;
    }
    const stops = Array.isArray(c.paleta) ? c.paleta : (PALETAS[c.paleta] || PALETAS.viridis);
    const marcas = el('div', { class: 'marcas' });
    const N = 5;
    for (let i = 0; i < N; i++) marcas.append(el('span', { text: nf(c.decimales == null ? 1 : Math.min(c.decimales, 1)).format(c.dom[0] + (c.dom[1] - c.dom[0]) * i / (N - 1)) }));
    box.append(
      el('div', { class: 'barra', style: 'background:linear-gradient(to right,' + stops.join(',') + ')' }),
      marcas,
      el('div', { class: 'unidad', text: c.unidad ? 'Unidad: ' + c.unidad : '' })
    );
  }

  /* ---------- carga de datos ---------- */

  function cargar() {
    let fallos = 0;
    capas.forEach((c) => {
      const stops = Array.isArray(c.paleta) ? c.paleta : (PALETAS[c.paleta] || PALETAS.viridis);
      c.lut = buildLut(stops);
      TinyTiff.load(c.archivo, (p) => { c.estado.textContent = Math.round(p * 100) + ' %'; })
        .then((r) => {
          c.raster = r;
          c.dom = c.dominio || [r.min, r.max];
          c.estado.textContent = '';
          if (c === S.activa) { drawLegend(); requestDraw(); }
          if (S.sel) updateInfo();
        })
        .catch((e) => {
          console.error(c.archivo, e);
          c.error = e.message || String(e);
          c.estado.textContent = 'error';
          c.estado.title = c.error;
          c.dom = [0, 1];
          if (++fallos === capas.length) mostrarError();
          if (c === S.activa) drawLegend();
          if (S.sel) updateInfo();
        });
    });
  }

  function mostrarError() {
    const b = $('#aviso');
    b.hidden = false;
    b.textContent = 'No se pudieron cargar los datos. Si abriste index.html haciendo doble clic, el navegador lo impide: publicá la carpeta en un servidor web (por ejemplo GitHub Pages) o abrila con un servidor local.';
  }

  /* ---------- enlace con estado (hash) ---------- */

  let hashTimer = 0;
  function scheduleHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      const p = new URLSearchParams();
      if (S.activa) p.set('c', S.activa.id);
      p.set('b', S.base);
      p.set('z', S.zoom.toFixed(2));
      const g = { lat: myToLat(S.cy), lon: wrapLon(mxToLon(S.cx)) };
      p.set('lat', g.lat.toFixed(4)); p.set('lng', g.lon.toFixed(4));
      if (S.sel) p.set('s', S.sel.lat.toFixed(4) + ',' + S.sel.lon.toFixed(4));
      try { history.replaceState(null, '', '#' + p.toString()); } catch (e) { /* ignorar */ }
    }, 350);
  }

  /* ---------- interacción ---------- */

  const pointers = new Map();
  let drag = null, pinch = null, down = null, idleTimer = 0, anim = 0;

  function interacting() {
    S.interacting = true;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { S.interacting = false; requestDraw(); scheduleHash(); }, 170);
  }

  function animateZoom(px, py, target) {
    cancelAnimationFrame(anim);
    const z0 = S.zoom, t0 = performance.now(), D = 200;
    target = Math.max(0, Math.min(MAXZ, target));
    (function step(t) {
      const f = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - f, 3);
      interacting();
      zoomAt(px, py, z0 + (target - z0) * e);
      requestDraw();
      if (f < 1) anim = requestAnimationFrame(step);
    })(t0);
  }

  function bindMap() {
    map.addEventListener('pointerdown', (e) => {
      cancelAnimationFrame(anim);
      map.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        drag = { x: e.clientX, y: e.clientY, cx: S.cx, cy: S.cy, sz: worldSize() };
        down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
        map.classList.add('arrastrando');
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const Sz = worldSize();
        pinch = {
          d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: S.zoom,
          mx: S.cx + (mid.x - S.W / 2) / Sz, my: S.cy + (mid.y - S.H / 2) / Sz
        };
        drag = null;
        if (down) down.moved = true;
      }
    });

    map.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        S.zoom = pinch.z0 + Math.log2((Math.hypot(a.x - b.x, a.y - b.y) || 1) / pinch.d0);
        clampView();
        const Sz = worldSize();
        S.cx = pinch.mx - (mid.x - S.W / 2) / Sz;
        S.cy = pinch.my - (mid.y - S.H / 2) / Sz;
        clampView();
        interacting(); requestDraw();
      } else if (pointers.size === 1 && drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) down.moved = true;
        if (down && down.moved) {
          S.cx = drag.cx - dx / drag.sz;
          S.cy = drag.cy - dy / drag.sz;
          clampView();
          interacting(); requestDraw();
        }
      }
      if (e.pointerType === 'mouse' && e.buttons === 0) hover(e.clientX, e.clientY);
    });

    const up = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        map.classList.remove('arrastrando');
        if (e.type === 'pointerup' && down && !down.moved && performance.now() - down.t < 700) {
          const g = screenToGeo(e.clientX, e.clientY);
          if (g.inside) selectGeo(g.lon, g.lat);
        }
        drag = null; pinch = null; down = null;
        interacting();
      } else if (pointers.size === 1) {
        const p = [...pointers.values()][0];
        drag = { x: p.x, y: p.y, cx: S.cx, cy: S.cy, sz: worldSize() };
        pinch = null;
        if (down) down.moved = true;
      }
    };
    map.addEventListener('pointerup', up);
    map.addEventListener('pointercancel', up);
    map.addEventListener('pointerleave', () => { $('#hud').hidden = true; });

    map.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      interacting();
      zoomAt(e.clientX, e.clientY, S.zoom - d * 0.0022);
      requestDraw();
    }, { passive: false });

    map.addEventListener('dblclick', (e) => animateZoom(e.clientX, e.clientY, S.zoom + 1));

    map.addEventListener('keydown', (e) => {
      const step = 90 / worldSize();
      if (e.key === '+' || e.key === '=') animateZoom(S.W / 2, S.H / 2, S.zoom + 1);
      else if (e.key === '-' || e.key === '_') animateZoom(S.W / 2, S.H / 2, S.zoom - 1);
      else if (e.key === 'ArrowLeft') S.cx -= step;
      else if (e.key === 'ArrowRight') S.cx += step;
      else if (e.key === 'ArrowUp') S.cy -= step;
      else if (e.key === 'ArrowDown') S.cy += step;
      else return;
      e.preventDefault();
      clampView(); interacting(); requestDraw();
    });

    $('#zin').addEventListener('click', () => animateZoom(S.W / 2, S.H / 2, S.zoom + 1));
    $('#zout').addEventListener('click', () => animateZoom(S.W / 2, S.H / 2, S.zoom - 1));
    $('#zhome').addEventListener('click', () => { fitBounds(CFG.vistaInicial); interacting(); requestDraw(); });
    window.addEventListener('resize', resize);
  }

  function hover(x, y) {
    const hud = $('#hud');
    const c = S.activa;
    const g = screenToGeo(x, y);
    if (!g.inside) { hud.hidden = true; return; }
    let txt = fmtCoord(g.lat, g.lon);
    if (c && c.raster) {
      const h = valueAt(c.raster, g.lon, g.lat);
      txt += ' · ' + (h.fuera || h.v === null ? 'sin dato' : fmtVal(h.v, c));
    }
    hud.textContent = txt;
    hud.hidden = false;
  }

  /* ---------- inicio ---------- */

  function init() {
    const q = new URLSearchParams(location.hash.slice(1));
    if (q.get('b') && BASES[q.get('b')]) S.base = q.get('b');
    else if (BASES[CFG.mapaBase]) S.base = CFG.mapaBase;

    buildPanel();
    bindMap();
    resize();

    if (q.has('z') && q.has('lat') && q.has('lng') && isFinite(+q.get('z'))) {
      S.zoom = +q.get('z');
      S.cx = lonToMx(+q.get('lng')); S.cy = latToMy(+q.get('lat'));
      clampView();
    } else {
      fitBounds(CFG.vistaInicial);
    }

    setActiva(capaById(q.get('c')) || capas[0]);
    if (q.get('s')) {
      const [la, lo] = q.get('s').split(',').map(Number);
      if (isFinite(la) && isFinite(lo)) S.sel = { lon: wrapLon(lo), lat: la };
    }
    updateInfo();
    cargar();
    requestDraw();
  }

  init();

  // Utilidades de depuración (consola del navegador)
  window.visor = { S, capas, valueAt, screenToGeo, geoToScreen, selectGeo, fitBounds };
})();
