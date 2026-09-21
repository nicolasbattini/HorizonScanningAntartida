/*
 * tiff.js — lector mínimo de GeoTIFF para el visor (sin dependencias).
 *
 * Lee la primera página y la primera banda de un GeoTIFF en coordenadas
 * geográficas (EPSG:4326) y devuelve los valores como Float32Array.
 * Soporta: TIFF clásico y BigTIFF, orientación en franjas (strips) o
 * teselas (tiles), compresión sin comprimir / LZW / DEFLATE, predictor
 * horizontal (2), enteros con o sin signo y coma flotante (32/64 bits).
 */
(function (global) {
  'use strict';

  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };

  function readTag(dv, t, le) {
    if (t.type === 2) {
      let s = '';
      for (let i = 0; i < t.count; i++) {
        const c = dv.getUint8(t.pos + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    }
    const sz = TYPE_SIZE[t.type] || 1;
    const out = new Array(t.count);
    for (let i = 0; i < t.count; i++) {
      const o = t.pos + i * sz;
      let v;
      switch (t.type) {
        case 1: case 7: v = dv.getUint8(o); break;
        case 3: v = dv.getUint16(o, le); break;
        case 4: case 13: v = dv.getUint32(o, le); break;
        case 5: v = dv.getUint32(o, le) / dv.getUint32(o + 4, le); break;
        case 6: v = dv.getInt8(o); break;
        case 8: v = dv.getInt16(o, le); break;
        case 9: v = dv.getInt32(o, le); break;
        case 11: v = dv.getFloat32(o, le); break;
        case 12: v = dv.getFloat64(o, le); break;
        case 16: case 18: v = Number(dv.getBigUint64(o, le)); break;
        case 17: v = Number(dv.getBigInt64(o, le)); break;
        default: v = 0;
      }
      out[i] = v;
    }
    return out;
  }

  function parseHeader(buf) {
    const dv = new DataView(buf);
    const bo = dv.getUint16(0, false);
    const le = bo === 0x4949;
    if (!le && bo !== 0x4d4d) throw new Error('El archivo no es un TIFF');
    const magic = dv.getUint16(2, le);
    let big = false;
    let ifd;
    if (magic === 42) ifd = dv.getUint32(4, le);
    else if (magic === 43) { big = true; ifd = Number(dv.getBigUint64(8, le)); }
    else throw new Error('Versión de TIFF desconocida');

    const n = big ? Number(dv.getBigUint64(ifd, le)) : dv.getUint16(ifd, le);
    let p = ifd + (big ? 8 : 2);
    const inline = big ? 8 : 4;
    const tags = {};
    for (let i = 0; i < n; i++, p += big ? 20 : 12) {
      const tag = dv.getUint16(p, le);
      const type = dv.getUint16(p + 2, le);
      const count = big ? Number(dv.getBigUint64(p + 4, le)) : dv.getUint32(p + 4, le);
      const valPos = p + (big ? 12 : 8);
      const size = (TYPE_SIZE[type] || 1) * count;
      const pos = size <= inline ? valPos : (big ? Number(dv.getBigUint64(valPos, le)) : dv.getUint32(valPos, le));
      tags[tag] = { type, count, pos };
    }
    const get = (tag, def) => (tags[tag] ? readTag(dv, tags[tag], le) : def);
    const one = (tag, def) => { const v = get(tag); return v === undefined ? def : (Array.isArray(v) ? v[0] : v); };
    return { dv, le, tags, get, one };
  }

  /* ---------- descompresión ---------- */

  function lzwDecode(src, expected) {
    const out = new Uint8Array(expected);
    const prefix = new Int32Array(4096);
    const suffix = new Uint8Array(4096);
    const lens = new Uint16Array(4096);
    let next = 258, bits = 9, buf = 0, cnt = 0, sp = 0, pos = 0, old = -1, prevStart = 0;

    function emit(code) {
      const len = code < 256 ? 1 : lens[code];
      if (pos + len > expected) return -1;
      let q = pos + len - 1, c = code;
      while (c >= 258) { out[q--] = suffix[c]; c = prefix[c]; }
      out[q] = c;
      const start = pos;
      pos += len;
      return start;
    }

    for (;;) {
      while (cnt < bits) {
        if (sp >= src.length) return out;
        buf = ((buf << 8) | src[sp++]) >>> 0;
        cnt += 8;
      }
      const code = (buf >>> (cnt - bits)) & ((1 << bits) - 1);
      cnt -= bits;
      buf &= (1 << cnt) - 1;

      if (code === 257) break;
      if (code === 256) { next = 258; bits = 9; old = -1; continue; }
      if (old === -1) {
        if (pos >= expected) break;
        prevStart = pos;
        out[pos++] = code;
        old = code;
        continue;
      }
      let start;
      if (code < next) {
        start = emit(code);
        if (start < 0) break;
        if (next < 4096) {
          prefix[next] = old;
          suffix[next] = out[start];
          lens[next] = (old < 256 ? 1 : lens[old]) + 1;
          next++;
        }
      } else {
        if (next < 4096) {
          prefix[next] = old;
          suffix[next] = out[prevStart];
          lens[next] = (old < 256 ? 1 : lens[old]) + 1;
          start = emit(next);
          next++;
        } else {
          start = -1;
        }
        if (start < 0) break;
      }
      prevStart = start;
      old = code;
      if (next + 1 >= (1 << bits) && bits < 12) bits++;
    }
    return out;
  }

  async function inflate(u8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Este navegador no puede descomprimir DEFLATE (se necesita un navegador reciente)');
    }
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* ---------- decodificación de un segmento ---------- */

  function applyPredictor2(raw, segW, segH, spp, bps, le) {
    const rowSamples = segW * spp;
    if (le && (bps === 8 || bps === 16 || bps === 32)) {
      const a = bps === 8 ? raw : bps === 16
        ? new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1)
        : new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
      for (let r = 0; r < segH; r++) {
        const b = r * rowSamples;
        for (let x = spp; x < rowSamples; x++) a[b + x] += a[b + x - spp];
      }
      return;
    }
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const bytes = bps >> 3;
    const mask = bps === 32 ? 0xffffffff : (1 << bps) - 1;
    const rd = bps === 8 ? (o) => dv.getUint8(o) : bps === 16 ? (o) => dv.getUint16(o, le) : (o) => dv.getUint32(o, le);
    const wr = bps === 8 ? (o, v) => dv.setUint8(o, v) : bps === 16 ? (o, v) => dv.setUint16(o, v, le) : (o, v) => dv.setUint32(o, v >>> 0, le);
    for (let r = 0; r < segH; r++) {
      const b = r * rowSamples;
      for (let x = spp; x < rowSamples; x++) {
        wr((b + x) * bytes, (rd((b + x) * bytes) + rd((b + x - spp) * bytes)) & mask);
      }
    }
  }

  function extractBand0(raw, n, cfg) {
    const { spp, bps, sf, le } = cfg;
    if (bps === 32 && sf === 3 && le) {
      const f = new Float32Array(raw.buffer, raw.byteOffset, n * spp);
      if (spp === 1) return f;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = f[i * spp];
      return out;
    }
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const bytes = bps >> 3;
    let rd;
    if (sf === 3 && bps === 32) rd = (o) => dv.getFloat32(o, le);
    else if (sf === 3 && bps === 64) rd = (o) => dv.getFloat64(o, le);
    else if (sf === 2 && bps === 8) rd = (o) => dv.getInt8(o);
    else if (sf === 2 && bps === 16) rd = (o) => dv.getInt16(o, le);
    else if (sf === 2 && bps === 32) rd = (o) => dv.getInt32(o, le);
    else if (bps === 8) rd = (o) => dv.getUint8(o);
    else if (bps === 16) rd = (o) => dv.getUint16(o, le);
    else if (bps === 32) rd = (o) => dv.getUint32(o, le);
    else throw new Error('Tipo de dato no soportado (' + bps + ' bits, formato ' + sf + ')');
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = rd(i * spp * bytes);
    return out;
  }

  async function decodeSegment(u8, off, count, segW, segH, cfg) {
    const expected = segW * segH * cfg.spp * (cfg.bps >> 3);
    let raw;
    if (cfg.comp === 1) raw = u8.slice(off, off + count);
    else if (cfg.comp === 5) raw = lzwDecode(u8.subarray(off, off + count), expected);
    else if (cfg.comp === 8 || cfg.comp === 32946) raw = await inflate(u8.subarray(off, off + count));
    else throw new Error('Compresión TIFF no soportada (código ' + cfg.comp + '). Usá LZW o DEFLATE.');
    if (raw.length < expected) { const p = new Uint8Array(expected); p.set(raw); raw = p; }
    if (cfg.pred === 2) applyPredictor2(raw, segW, segH, cfg.spp, cfg.bps, cfg.le);
    else if (cfg.pred !== 1) throw new Error('Predictor TIFF no soportado (código ' + cfg.pred + ')');
    return extractBand0(raw, segW * segH, cfg);
  }

  /* ---------- API ---------- */

  async function decode(buf) {
    const h = parseHeader(buf);
    const u8 = new Uint8Array(buf);
    const width = h.one(256), height = h.one(257);
    const cfg = {
      le: h.le,
      bps: h.one(258, 8),
      spp: h.one(277, 1),
      sf: h.one(339, 1),
      comp: h.one(259, 1),
      pred: h.one(317, 1)
    };
    const planar = h.one(284, 1);
    const tiled = !!h.tags[322];
    const offsets = h.get(tiled ? 324 : 273);
    const counts = h.get(tiled ? 325 : 279);
    if (!offsets || !counts) throw new Error('No se encontraron los bloques de datos del TIFF');

    const out = new Float32Array(width * height);
    let nSeg, tw = 0, th = 0, rps = 0, across = 0;
    if (tiled) {
      tw = h.one(322); th = h.one(323);
      across = Math.ceil(width / tw);
      nSeg = across * Math.ceil(height / th);
    } else {
      rps = Math.min(h.one(278, height), height);
      nSeg = Math.ceil(height / rps);
    }
    if (planar === 2) nSeg = Math.min(nSeg, offsets.length); // sólo banda 1

    const place = (i, seg) => {
      if (tiled) {
        const ty = Math.floor(i / across), tx = i % across;
        const x0 = tx * tw, y0 = ty * th;
        const w = Math.min(tw, width - x0), hh = Math.min(th, height - y0);
        for (let yy = 0; yy < hh; yy++) out.set(seg.subarray(yy * tw, yy * tw + w), (y0 + yy) * width + x0);
      } else {
        out.set(seg.subarray(0, Math.min(seg.length, (height - i * rps) * width)), i * rps * width);
      }
    };

    const BATCH = 48;
    for (let s = 0; s < nSeg; s += BATCH) {
      const jobs = [];
      for (let i = s; i < Math.min(nSeg, s + BATCH); i++) {
        const segW = tiled ? tw : width;
        const segH = tiled ? th : Math.min(rps, height - i * rps);
        jobs.push(decodeSegment(u8, offsets[i], counts[i], segW, segH, cfg).then((seg) => place(i, seg)));
      }
      await Promise.all(jobs);
      await new Promise((r) => setTimeout(r, 0)); // cede el hilo para que la página no se congele
    }

    // Georreferenciación
    const scale = h.get(33550), tie = h.get(33922);
    if (!scale || !tie) throw new Error('El TIFF no tiene georreferenciación (ModelPixelScale/Tiepoint)');
    const keys = h.get(34735, []);
    const geo = {};
    for (let k = 4; k + 3 < keys.length; k += 4) geo[keys[k]] = keys[k + 3];
    const epsg = geo[2048] || geo[3072] || null;
    if (epsg && epsg !== 4326) {
      throw new Error('La capa está en EPSG:' + epsg + '. El visor espera coordenadas geográficas WGS84 (EPSG:4326); reproyectá la capa.');
    }
    let x0 = tie[3] - tie[0] * scale[0];
    let y0 = tie[4] + tie[1] * scale[1];
    if (geo[1025] === 2) { x0 -= scale[0] / 2; y0 += scale[1] / 2; } // PixelIsPoint

    // Valor sin dato -> NaN, y estadísticas
    let nodata = h.get(42113);
    nodata = typeof nodata === 'string' && nodata.length ? parseFloat(nodata) : null;
    const useNd = nodata !== null && !Number.isNaN(nodata);
    let min = Infinity, max = -Infinity, valid = 0;
    for (let i = 0; i < out.length; i++) {
      let v = out[i];
      if (useNd && v === nodata) { out[i] = NaN; continue; }
      if (v - v !== 0) { out[i] = NaN; continue; } // NaN o infinito
      if (v < min) min = v;
      if (v > max) max = v;
      valid++;
    }
    return { width, height, data: out, x0, y0, dx: scale[0], dy: scale[1], min, max, valid };
  }

  async function load(url, onProgress) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('No se pudo descargar ' + url + ' (HTTP ' + resp.status + ')');
    const total = +resp.headers.get('Content-Length') || 0;
    let buf;
    if (resp.body && total && onProgress) {
      const reader = resp.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        onProgress(Math.min(1, got / total));
      }
      const all = new Uint8Array(got);
      let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      buf = all.buffer;
    } else {
      buf = await resp.arrayBuffer();
    }
    return decode(buf);
  }

  global.TinyTiff = { load, decode };
})(window);
