/* SVG charts for Uniswap v3 LP Dashboard. No dependencies. window.Charts */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, a = {}, p) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) if (v != null) n.setAttribute(k, v); if (p) p.appendChild(n); return n; };
  const lin = (d0, d1, r0, r1) => { const f = (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0); f.inv = (p) => d0 + ((p - r0) / (r1 - r0)) * (d1 - d0); return f; };
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const path = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
  function ticks(min, max, n = 5) {
    const span = max - min || 1, m = Math.pow(10, Math.floor(Math.log10(span / n)));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * m).find((s) => span / s <= n + 0.5) || m * 10;
    const out = []; for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10)); return out;
  }
  const kfmt = (v) => Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.abs(v) >= 1e4 ? (v / 1e3).toFixed(0) + 'k' : Math.abs(v) >= 1000 ? (v / 1e3).toFixed(1) + 'k' : (+v.toPrecision(3)).toString();

  function frame(c, pad = {}) {
    c.innerHTML = '';
    const W = Math.max(300, c.clientWidth), H = Math.max(120, c.clientHeight || 150);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' }, c);
    const tip = document.createElement('div'); tip.className = 'tip'; c.appendChild(tip);
    return { svg, tip, W, H, l: pad.l ?? 44, r: W - (pad.r ?? 8), t: pad.t ?? 6, b: H - (pad.b ?? 18) };
  }
  const pt = (f, e) => { const r = f.svg.getBoundingClientRect(); return { x: (e.clientX - r.left) * (f.W / r.width), y: (e.clientY - r.top) * (f.H / r.height) }; };
  function tip(f, html, x, y) {
    f.tip.innerHTML = html; f.tip.style.display = 'block';
    const s = f.svg.clientWidth / f.W, w = f.tip.offsetWidth, h = f.tip.offsetHeight;
    let L = x * s + 12; if (L + w > f.svg.clientWidth) L = x * s - w - 12;
    let T = y * s - h / 2; T = Math.max(0, Math.min(T, f.svg.clientHeight - h));
    f.tip.style.left = L + 'px'; f.tip.style.top = T + 'px';
  }
  const hide = (f) => { f.tip.style.display = 'none'; };

  /**
   * Price history + forward cone (left) and liquidity profile (right), sharing one price axis,
   * with a draggable range band across both.
   */
  function priceProfile(c, o) {
    const PROFILE_W = Math.min(200, Math.max(120, c.clientWidth * 0.2));
    const f = frame(c, { l: 50, r: 8, t: 8, b: 18 });
    const xSplit = f.r - PROFILE_W, gap = 10;
    const hist = o.history, nH = hist.length, nF = o.cone.length;
    const xs = lin(0, nH + nF, f.l, xSplit - gap);
    const yVals = [o.range.lower, o.range.upper, o.spot, ...hist.slice(-Math.min(nH, 30)).flatMap((d) => [d.low, d.high]), ...o.cone.flatMap((c2) => [c2.p5, c2.p95])];
    let lo = Math.min(...yVals), hi = Math.max(...yVals); const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
    lo = Math.max(lo, o.bars[0].priceLow); hi = Math.min(hi, o.bars[o.bars.length - 1].priceHigh);
    const y = lin(lo, hi, f.b, f.t);
    const cid = 'clip' + Math.random().toString(36).slice(2, 8);
    el('rect', { x: f.l, y: f.t, width: f.r - f.l, height: f.b - f.t }, el('clipPath', { id: cid }, el('defs', {}, f.svg)));
    const g = el('g', {}, f.svg);
    for (const t of ticks(lo, hi, 7)) {
      el('line', { x1: f.l, x2: f.r, y1: y(t), y2: y(t), stroke: css('--rule'), 'stroke-width': 1 }, g);
      el('text', { x: f.l - 5, y: y(t) + 3, 'text-anchor': 'end' }, g).textContent = t.toLocaleString('en-US');
    }
    hist.forEach((d, i) => { if (i % 14 === 0) el('text', { x: xs(i + 0.5), y: f.H - 5, 'text-anchor': 'middle' }, g).textContent = d.date.slice(5); });
    el('text', { x: xs(nH + nF / 2), y: f.H - 5, 'text-anchor': 'middle' }, g).textContent = o.simple ? `+${nF}d` : `+${nF}d (model)`;
    el('line', { x1: xs(nH), x2: xs(nH), y1: f.t, y2: f.b, stroke: css('--rule-2'), 'stroke-dasharray': '2 3' }, g);
    const P = el('g', { 'clip-path': `url(#${cid})` }, f.svg);
    // band
    const band = el('rect', { x: f.l, width: f.r - f.l, fill: css('--band') }, P);
    // profile bars
    const maxL = Math.max(...o.bars.map((b) => b.L || 0));
    const xp = lin(0, maxL, xSplit, f.r);
    const barEls = o.bars.map((b) => {
      if (!b.L || b.priceHigh < lo || b.priceLow > hi) return null;
      const y1 = y(Math.min(b.priceHigh, hi)), y2 = y(Math.max(b.priceLow, lo));
      return { b, r: el('rect', { x: xSplit, y: y1 + 0.5, width: Math.max(1, xp(b.L) - xSplit), height: Math.max(1, y2 - y1 - 1), fill: css('--bar') }, P) };
    }).filter(Boolean);
    el('line', { x1: xp(o.activeL), x2: xp(o.activeL), y1: f.t, y2: f.b, stroke: css('--muted'), 'stroke-dasharray': '2 2' }, f.svg);
    el('text', { x: xp(o.activeL) + 3, y: f.t + 9, style: 'font-size:9px' }, f.svg).textContent = o.simple ? 'current' : 'active L';
    // cone
    const cone = [[xs(nH), y(o.spot)], ...o.cone.map((c2, i) => [xs(nH + i + 1), y(c2.p95)])].concat([...o.cone].reverse().map((c2, i) => [xs(nH + o.cone.length - i), y(c2.p5)]), [[xs(nH), y(o.spot)]]);
    el('path', { d: path(cone) + 'Z', fill: css('--series-7'), 'fill-opacity': 0.12, stroke: 'none' }, P);
    el('path', { d: path([[xs(nH), y(o.spot)], ...o.cone.map((c2, i) => [xs(nH + i + 1), y(c2.p50)])]), fill: 'none', stroke: css('--series-7'), 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, P);
    for (const k of ['p5', 'p95']) el('path', { d: path([[xs(nH), y(o.spot)], ...o.cone.map((c2, i) => [xs(nH + i + 1), y(c2[k])])]), fill: 'none', stroke: css('--series-7'), 'stroke-width': 1, 'stroke-opacity': 0.6 }, P);
    // candles + close
    hist.forEach((d, i) => el('line', { x1: xs(i + 0.5), x2: xs(i + 0.5), y1: y(d.high), y2: y(d.low), stroke: css('--muted'), 'stroke-width': 1.5, 'stroke-opacity': 0.55 }, P));
    el('path', { d: path(hist.map((d, i) => [xs(i + 0.5), y(d.close)]).concat([[xs(nH), y(o.spot)]])), fill: 'none', stroke: css('--text'), 'stroke-width': 1.5 }, P);
    // spot line
    el('line', { x1: xs(nH), x2: f.r, y1: y(o.spot), y2: y(o.spot), stroke: css('--text'), 'stroke-width': 1, 'stroke-dasharray': '1 2' }, f.svg);
    el('circle', { cx: xs(nH), cy: y(o.spot), r: 3.5, fill: css('--text') }, f.svg);
    const sl = el('text', { x: xSplit - gap - 4, y: y(o.spot) - 4, 'text-anchor': 'end', class: 'lab', style: `fill:${css('--text')}` }, f.svg); sl.textContent = o.spot.toFixed(2);
    // draggable bounds
    const B = { lower: o.range.lower, upper: o.range.upper };
    const mk = (key) => {
      const gl = el('g', { style: 'cursor:ns-resize' }, f.svg);
      const hit = el('rect', { x: f.l, width: f.r - f.l, height: 12, fill: 'transparent' }, gl);
      const ln = el('line', { x1: f.l, x2: f.r, stroke: css('--band-edge'), 'stroke-width': 1.5 }, gl);
      const tag = el('rect', { x: f.l, width: 118, height: 14, rx: 2, fill: css('--band-edge') }, gl);
      const tx = el('text', { x: f.l + 4, class: 'lab', style: 'fill:#fff;font-size:10px' }, gl);
      return { key, gl, hit, ln, tag, tx };
    };
    const Lh = mk('lower'), Uh = mk('upper');
    const place = () => {
      band.setAttribute('y', y(B.upper)); band.setAttribute('height', Math.max(0, y(B.lower) - y(B.upper)));
      for (const h of [Lh, Uh]) {
        const yy = y(B[h.key]);
        h.ln.setAttribute('y1', yy); h.ln.setAttribute('y2', yy); h.hit.setAttribute('y', yy - 6);
        const ty = h.key === 'upper' ? yy - 14 : yy; h.tag.setAttribute('y', ty); h.tx.setAttribute('y', ty + 10.5);
        h.tx.textContent = `${h.key === 'upper' ? '▲' : '▼'} ${B[h.key].toFixed(2)}  ${((B[h.key] / o.spot - 1) * 100).toFixed(1)}%`;
      }
      for (const be of barEls) be.r.setAttribute('fill', be.b.priceHigh > B.lower && be.b.priceLow < B.upper ? css('--bar-in') : css('--bar'));
    };
    place();
    let drag = null;
    for (const h of [Lh, Uh]) {
      h.gl.addEventListener('pointerdown', (e) => { drag = h.key; h.gl.setPointerCapture(e.pointerId); e.preventDefault(); });
      h.gl.addEventListener('pointermove', (e) => {
        if (drag !== h.key) return;
        const v = y.inv(pt(f, e).y);
        if (h.key === 'lower') B.lower = Math.max(lo, Math.min(v, B.upper * 0.998)); else B.upper = Math.min(hi, Math.max(v, B.lower * 1.002));
        place();
        o.onDrag && o.onDrag({ ...B });
      });
      h.gl.addEventListener('pointerup', () => { if (drag) { drag = null; o.onRangeChange && o.onRangeChange({ ...B }); } });
    }
    // hover
    const hov = el('rect', { x: f.l, y: f.t, width: f.r - f.l, height: f.b - f.t, fill: 'transparent' }, f.svg);
    f.svg.insertBefore(hov, Lh.gl);
    const cross = el('line', { x1: f.l, x2: f.r, stroke: css('--muted'), 'stroke-dasharray': '2 2', visibility: 'hidden' }, f.svg);
    hov.addEventListener('pointermove', (e) => {
      const p = pt(f, e), price = y.inv(p.y);
      cross.setAttribute('y1', p.y); cross.setAttribute('y2', p.y); cross.setAttribute('visibility', 'visible');
      if (p.x >= xSplit) {
        const b = o.bars.find((bb) => price >= bb.priceLow && price < bb.priceHigh);
        if (!b || !b.L) return hide(f);
        const share = o.yourL ? o.yourL / (b.L + o.yourL) : null;
        tip(f, o.simple
          ? `<b>$${b.priceLow.toFixed(0)}–$${b.priceHigh.toFixed(0)}</b><br>liquidity ${(b.L / o.activeL).toFixed(2)}× current` + (share ? `<br>your fee share ${(share * 100).toFixed(3)}%` : '')
          : `<b>${b.priceLow.toFixed(0)}–${b.priceHigh.toFixed(0)}</b><br>pool L ${b.L.toExponential(3)}<br>${(b.L / o.activeL * 100).toFixed(0)}% of active L` + (share ? `<br>your share here ${(share * 100).toFixed(4)}%` : ''), p.x, p.y);
      } else {
        const i = Math.floor(xs.inv(p.x));
        if (i >= 0 && i < nH) { const d = hist[i]; tip(f, `<b>${d.date}</b><br>O ${d.open.toFixed(2)} H ${d.high.toFixed(2)}<br>L ${d.low.toFixed(2)} C ${d.close.toFixed(2)}<br>vol $${kfmt(d.volumeUsd)}`, p.x, p.y); }
        else if (i >= nH && i < nH + nF) { const c2 = o.cone[i - nH]; tip(f, o.simple ? `<b>+${c2.day}d</b><br>90%: $${c2.p5.toFixed(0)} – $${c2.p95.toFixed(0)}<br>median $${c2.p50.toFixed(0)}` : `<b>day +${c2.day}</b> (model)<br>P95 ${c2.p95.toFixed(0)}<br>P50 ${c2.p50.toFixed(0)}<br>P5 ${c2.p5.toFixed(0)}`, p.x, p.y); }
        else hide(f);
      }
    });
    hov.addEventListener('pointerleave', () => { hide(f); cross.setAttribute('visibility', 'hidden'); });
  }

  function lineChart(c, { series, tipRow, xFmt = kfmt, yFmt = kfmt, shade, marker, xLabels }) {
    const f = frame(c, { l: 40, r: 6, t: 6, b: 16 });
    const X = series.flatMap((s) => s.values.map((v) => v.x)), Y = series.flatMap((s) => s.values.map((v) => v.y));
    const x0 = Math.min(...X), x1 = Math.max(...X); let y0 = Math.min(...Y), y1 = Math.max(...Y); const pd = (y1 - y0) * 0.08 || 1; y0 -= pd; y1 += pd;
    const x = lin(x0, x1, f.l, f.r), y = lin(y0, y1, f.b, f.t);
    for (const t of ticks(y0, y1, 4)) { el('line', { x1: f.l, x2: f.r, y1: y(t), y2: y(t), stroke: css('--rule') }, f.svg); el('text', { x: f.l - 4, y: y(t) + 3, 'text-anchor': 'end' }, f.svg).textContent = yFmt(t); }
    if (shade) el('rect', { x: x(Math.max(x0, shade[0])), width: Math.max(0, x(Math.min(x1, shade[1])) - x(Math.max(x0, shade[0]))), y: f.t, height: f.b - f.t, fill: css('--band') }, f.svg);
    (xLabels || ticks(x0, x1, 4).map((t) => [t, xFmt(t)])).forEach(([v, t]) => { el('text', { x: x(v), y: f.H - 3, 'text-anchor': 'middle' }, f.svg).textContent = t; });
    if (marker) el('line', { x1: x(marker), x2: x(marker), y1: f.t, y2: f.b, stroke: css('--muted'), 'stroke-dasharray': '2 2' }, f.svg);
    for (const s of series) el('path', { d: path(s.values.map((v) => [x(v.x), y(v.y)])), fill: 'none', stroke: s.color, 'stroke-width': 1.75, 'stroke-dasharray': s.dash }, f.svg);
    const cross = el('line', { y1: f.t, y2: f.b, stroke: css('--muted'), visibility: 'hidden' }, f.svg);
    const hit = el('rect', { x: f.l, y: f.t, width: f.r - f.l, height: f.b - f.t, fill: 'transparent' }, f.svg);
    hit.addEventListener('pointermove', (e) => {
      const p = pt(f, e), xv = x.inv(p.x), base = series[0].values;
      let i = 0, best = Infinity; base.forEach((v, j) => { const d = Math.abs(v.x - xv); if (d < best) { best = d; i = j; } });
      cross.setAttribute('x1', x(base[i].x)); cross.setAttribute('x2', x(base[i].x)); cross.setAttribute('visibility', 'visible');
      tip(f, tipRow(i), p.x, p.y);
    });
    hit.addEventListener('pointerleave', () => { hide(f); cross.setAttribute('visibility', 'hidden'); });
  }

  function histogram(c, { bins, fmt, total }) {
    const f = frame(c, { l: 30, r: 6, t: 6, b: 16 });
    const x = lin(bins[0].from, bins[bins.length - 1].to, f.l, f.r), maxC = Math.max(...bins.map((b) => b.count)), y = lin(0, maxC, f.b, f.t);
    for (const t of ticks(0, maxC, 3)) { el('line', { x1: f.l, x2: f.r, y1: y(t), y2: y(t), stroke: css('--rule') }, f.svg); el('text', { x: f.l - 3, y: y(t) + 3, 'text-anchor': 'end' }, f.svg).textContent = ((t / total) * 100).toFixed(0) + '%'; }
    ticks(bins[0].from, bins[bins.length - 1].to, 4).forEach((t) => { el('text', { x: x(t), y: f.H - 3, 'text-anchor': 'middle' }, f.svg).textContent = fmt(t); });
    if (bins[0].from < 0 && bins[bins.length - 1].to > 0) el('line', { x1: x(0), x2: x(0), y1: f.t, y2: f.b, stroke: css('--muted') }, f.svg);
    for (const b of bins) {
      const x0 = x(b.from) + 0.5, w = Math.max(1, x(b.to) - x(b.from) - 1), mid = (b.from + b.to) / 2;
      const r = el('rect', { x: x0, y: y(b.count), width: w, height: f.b - y(b.count), fill: mid < 0 ? css('--series-2') : css('--series-1') }, f.svg);
      const h = el('rect', { x: x0, y: f.t, width: w, height: f.b - f.t, fill: 'transparent' }, f.svg);
      h.addEventListener('pointermove', (e) => { const p = pt(f, e); r.setAttribute('opacity', 0.7); tip(f, `${fmt(b.from)} … ${fmt(b.to)}<br>${((b.count / total) * 100).toFixed(1)}% of paths`, p.x, p.y); });
      h.addEventListener('pointerleave', () => { r.removeAttribute('opacity'); hide(f); });
    }
  }

  window.Charts = { priceProfile, lineChart, histogram, kfmt };
})();
