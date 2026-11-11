/* Uniswap v3 LP Dashboard — the web interface. Every number comes from the API (/api/analyze, /api/tiers). */
(function () {
  const $ = (id) => document.getElementById(id);
  const HOSTED = !!window.LPAPI;
  const S = { snapshotId: null, spot: null, history: null, result: null, view: 'widths' };

  async function api(method, path, body) {
    if (HOSTED) {
      const [p, qs] = path.split('?');
      const out = await window.LPAPI.handle({ method, path: p, query: Object.fromEntries(new URLSearchParams(qs || '')), body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
      if (out.status >= 400) throw Object.assign(new Error(out.body?.error?.message || 'error'), { api: out.body?.error });
      return out.body;
    }
    const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json();
    if (!res.ok) throw Object.assign(new Error(j?.error?.message || `HTTP ${res.status}`), { api: j?.error });
    return j;
  }

  const fin = (v) => v !== null && v !== undefined && isFinite(v);
  const usd = (v, d = 0) => (!fin(v) ? '—' : (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const susd = (v) => (fin(v) && v > 0 ? '+' : '') + usd(v);
  const musd = (v) => (!fin(v) ? '—' : '$' + (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : v.toFixed(0)));
  const pct = (v, d = 0) => (!fin(v) ? '—' : (v * 100).toFixed(d) + '%');
  const px = (v) => (!fin(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }));
  const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (id) => { const v = $(id).value.trim(); return v === '' ? undefined : Number(v); };
  const setRange = (a, b) => { $('rangeLower').value = a.toFixed(0); $('rangeUpper').value = b.toFixed(0); };

  function inputs() {
    const o = { capitalUsd: num('capitalUsd'), rangeLower: num('rangeLower'), rangeUpper: num('rangeUpper'), horizonDays: num('horizonDays'), liquidityMode: 'follow', compareWidthsPct: [2, 5, 10, 20, 30] };
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    return o;
  }

  let timer, seq = 0;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 300); };
  async function run() {
    const my = ++seq;
    document.body.classList.add('busy');
    try {
      const out = await api('POST', '/api/analyze', { snapshotId: S.snapshotId, inputs: inputs() });
      if (my !== seq) return;
      S.result = out.result; $('formStatus').className = 'status'; render();
    } catch (e) {
      if (my !== seq) return;
      const a = e.api;
      $('formStatus').className = 'status err';
      $('formStatus').innerHTML = a?.details?.problems ? a.details.problems.map((p) => esc(`${p.field}: ${p.message}`)).join('<br>') : esc(a?.message || e.message);
    } finally { if (my === seq) document.body.classList.remove('busy'); }
  }

  function render() {
    const r = S.result, m = r.market, pos = r.position, sim = r.simulation, f = r.fees, H = r.inputs.horizonDays;
    const P = pos.entryPrice.value;
    // strip
    const dailyMove = Math.exp(m.volatility.daily) - 1;
    $('stripStats').innerHTML = [
      ['ETH', `$${P.toLocaleString('en-US', { maximumFractionDigits: 2 })}`, 'observed · pool contract (slot0)', 'observed'],
      ['Volatility', `${pct(m.volatility.annual)} <small>±${pct(dailyMove, 1)}/day</small>`, `derived · annualized, last ${m.volatility.n} daily closes`, 'derived'],
      ['Volume / day', musd(m.volume.value), 'derived · 30-day average of GeckoTerminal daily volume', 'derived'],
      ['LP fees / day', musd(f.poolDailyFeesUsd), 'derived · volume × 0.05%', 'derived'],
      ['TVL', musd(m.tvl.value), 'observed · GeckoTerminal', 'observed'],
    ].map(([k, v, t, kind]) => `<div class="stat" title="${esc(t)}"><div class="k">${k} <i class="prov ${kind}"></i></div><div class="v">${v}</div></div>`).join('');
    $('asOf').textContent = `block ${r.snapshot.block} · ${r.snapshot.capturedAt.slice(5, 16).replace('T', ' ')} UTC`;
    $('asOf').title = `snapshot ${r.snapshot.id} · sha256 ${r.snapshot.contentHash}`;
    if (S.savedFor !== JSON.stringify(inputs())) { S.savedId = null; $('repro').textContent = ''; }

    // answer
    const lo = r.risk.atLower, up = r.risk.atUpper, worst = Math.min(lo.ilUsd, up.ilUsd);
    $('aFees').textContent = usd(f.expected.follow);
    $('aFeesS').innerHTML = `${pct(f.expectedApr.follow, 1)} APR · ${H}d`;
    $('aTime').textContent = pct(sim.meanTimeInRange);
    $('aTimeS').innerHTML = `history ${pct(r.historyRolling?.mean)}`;
    $('aEdge').textContent = usd(worst);
    $('aEdgeS').innerHTML = `$${px(lo.price)} <span class="neg">${usd(lo.ilUsd)}</span> · $${px(up.price)} <span class="neg">${usd(up.ilUsd)}</span>`;
    $('aNet').innerHTML = `<span class="${cls(sim.vsHodl.mean)}">${susd(sim.vsHodl.mean)}</span>`;
    $('aNetS').innerHTML = `beats hold ${pct(sim.probBeatHodl)} · after $${r.inputs.gasUsd} gas`;
    const be = r.breakEven;
    $('aBe').textContent = be.volumeUsd === 0 ? 'any' : fin(be.volumeUsd) ? `${musd(be.volumeUsd)}/day` : '—';
    $('aBeS').innerHTML = fin(be.multiple) && be.multiple > 0 ? `${be.multiple.toFixed(1)}× current ${musd(be.currentVolumeUsd)}` : '';
    const sc = r.scenarios.rows;
    $('scnSub').textContent = `steady move over ${H}d`;
    $('scn').innerHTML = '<tr><th>ETH</th><th>Price</th><th>In range</th><th>Fees</th><th>Net vs hold</th></tr>' + sc.map((x) => `<tr class="${x.move === 0 ? 'sel' : ''}"><td>${x.move > 0 ? '+' : ''}${(x.move * 100).toFixed(0)}%</td><td>$${px(x.price)}</td><td>${pct(x.timeInRange)}</td><td>${usd(x.fees)}</td><td class="${cls(x.vsHodl)}">${susd(x.vsHodl)}</td></tr>`).join('');

    $('deposit').innerHTML = [
      ['Range', `$${pos.range.lower.toFixed(2)} – $${pos.range.upper.toFixed(2)}`],
      ['WETH', pos.amounts.weth.toFixed(4)],
      ['USDC', usd(pos.amounts.usdc)],
      ['Split', `${pct(pos.composition.wethPct)} WETH / ${pct(pos.composition.usdcPct)} USDC`],
      ['ETH exposure now', `${pct(r.exposure.now.pctOfPosition)} · ${usd(r.exposure.now.usd)}`],
      [`at $${px(lo.price)} / $${px(up.price)}`, `${pct(r.exposure.atLower.pctOfPosition)} / ${pct(r.exposure.atUpper.pctOfPosition)}`],
    ].map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('');

    $('foot').innerHTML = `<span><i class="prov observed"></i> observed: pool contract @ block ${r.snapshot.block}, GeckoTerminal</span><span><i class="prov derived"></i> derived: calculated from observed data</span><span><i class="prov estimated"></i> estimated: model (${sim.params.paths.toLocaleString()} simulations)</span>`;

    // comparison
    const rows = r.comparison.rows;
    $('cmpNote').textContent = S.view === 'tiers' ? '' : `${usd(r.inputs.capitalUsd)} · ${H}d · click a row to apply`;
    $('cmpTable').innerHTML = `<tr><th>Range</th><th>Prices</th><th>Fees</th><th>In range</th><th>Edge loss</th><th>Net vs hold</th><th>Beats hold</th><th>Break-even volume/day</th></tr>` +
      rows.map((x, i) => `<tr class="${x.selected ? 'sel' : 'click'}" data-i="${i}"><td>${x.selected ? '<b>yours</b>' : '±' + x.widthPct + '%'}</td><td>$${px(x.lower)} – $${px(x.upper)}</td><td>${usd(x.expectedFeesFollow)}</td><td>${pct(x.meanTimeInRange)}</td><td class="neg">${usd(Math.min(x.ilAtLower, x.ilAtUpper))}</td><td class="${cls(x.expectedVsHodl)}">${susd(x.expectedVsHodl)}</td><td>${pct(x.probBeatHodl)}</td><td>${fin(x.breakEven.volumeUsd) ? musd(x.breakEven.volumeUsd) : '—'}</td></tr>`).join('');
    $('cmpTable').querySelectorAll('tr.click').forEach((tr) => tr.addEventListener('click', () => { const x = rows[+tr.dataset.i]; setRange(x.lower, x.upper); run(); }));

    draw();
    if (S.view === 'tiers') runTiers();
  }

  // ---------- fee tiers ----------
  let tseq = 0;
  async function runTiers() {
    const my = ++tseq;
    try {
      const out = await api('POST', '/api/tiers', { snapshotId: S.snapshotId, inputs: inputs() });
      if (my !== tseq) return;
      const t = out.result, rows = t.rows, H = t.inputs.horizonDays;
      $('cmpNote').textContent = `same range · ${usd(t.inputs.capitalUsd)} · ${H}d · each pool's own liquidity & volume`;
      if (rows.length < 2) { $('tierTable').innerHTML = '<tr><td class="mut">Only one fee tier in the data. Capture the 0.01% and 0.30% pools to compare.</td></tr>'; $('tierWarn').hidden = true; return; }
      $('tierTable').innerHTML = `<tr><th>Tier</th><th>Range</th><th>TVL</th><th>Volume/day mean · median</th><th>Share</th><th>Fees</th><th>Net vs hold</th><th>@ median volume</th><th>Break-even volume</th></tr>` +
        rows.map((x) => `<tr class="${x.base ? 'sel' : ''}"><td>${x.base ? '<b>' : ''}${+(x.feeTier * 100).toFixed(2)}%${x.base ? '</b>' : ''}</td><td>${px(x.range.lower)}–${px(x.range.upper)}</td><td>${musd(x.tvlUsd)}</td><td>${musd(x.volumeUsd)} · ${musd(x.volumeMedian30)}</td><td>${pct(x.shareNow, 3)}</td><td>${usd(x.expectedFees)}</td><td class="${cls(x.netVsHold)}">${susd(x.netVsHold)}</td><td class="${cls(x.netVsHoldAtMedianVolume)}">${susd(x.netVsHoldAtMedianVolume)}</td><td>${fin(x.breakEvenVolumeUsd) ? musd(x.breakEvenVolumeUsd) : '—'}</td></tr>`).join('');
      const base = rows.find((x) => x.base), lines = [];
      const thin = rows.filter((x) => !x.base && t.warnings.some((w) => w.code === 'TIER_TOO_GOOD' && w.message.startsWith(`${x.feeTier * 100}%`)));
      if (thin.length) lines.push(`${thin.map((x) => `${+(x.feeTier * 100).toFixed(2)}%`).join(' and ')} pool${thin.length > 1 ? 's are' : ' is'} ${thin.map((x) => `${(base.activeL / x.activeL).toFixed(0)}×`).join(' / ')} thinner than ${+(base.feeTier * 100).toFixed(2)}%, so your share looks big. Likely overstated: bot liquidity added around big swaps isn't visible in a snapshot.`);
      const lumpy = rows.filter((x) => x.volumeLumpiness > 1.5);
      if (lumpy.length) lines.push(`Lumpy volume (a few huge days): ${lumpy.map((x) => `${+(x.feeTier * 100).toFixed(2)}% mean ${x.volumeLumpiness.toFixed(1)}× median`).join(' · ')}. Compare the median-volume column.`);
      for (const w of t.warnings) if (w.code === 'TIER_SNAPSHOTS_NOT_SIMULTANEOUS' || w.code === 'TIER_OUT_OF_RANGE') lines.push(w.message);
      $('tierWarn').hidden = !lines.length;
      $('tierWarn').innerHTML = lines.map((l) => `<div>⚠ ${esc(l)}</div>`).join('');
    } catch (e) { if (my === tseq) { $('tierTable').innerHTML = `<tr><td class="neg">${esc(e.message)}</td></tr>`; } }
  }
  function setView(v) {
    S.view = v;
    document.querySelectorAll('#cmpSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    $('cmpTable').hidden = v !== 'widths'; $('tierTable').hidden = v !== 'tiers';
    if (v !== 'tiers') $('tierWarn').hidden = true;
    if (S.result) render();
  }

  function draw() {
    const r = S.result; if (!r || !S.history) return;
    Charts.priceProfile($('priceChart'), {
      simple: true, history: S.history, spot: r.position.entryPrice.value, cone: r.simulation.cone, bars: r.liquidity.bars, activeL: r.liquidity.activeL, yourL: r.position.liquidity, range: r.position.range,
      onDrag: (b) => setRange(b.lower, b.upper), onRangeChange: (b) => { setRange(b.lower, b.upper); run(); },
    });
  }

  async function save() {
    const out = await api('POST', '/api/analyses', { snapshotId: S.snapshotId, inputs: inputs(), label: `$${num('capitalUsd')} ${$('rangeLower').value}–${$('rangeUpper').value} ${num('horizonDays')}d` });
    S.savedId = out.analysis.id; S.savedFor = JSON.stringify(inputs());
    return out.analysis;
  }
  async function onSave() {
    try { const a = await save(); $('repro').innerHTML = `<span class="mut" title="${a.id}">saved ${a.id.slice(3, 9)}</span>`; }
    catch (e) { $('repro').innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
  }
  async function onVerify() {
    try {
      if (!S.savedId) await save();
      const r = await api('POST', `/api/analyses/${S.savedId}/replay`);
      $('repro').innerHTML = r.reproducible
        ? `<span class="pos" title="${S.savedId} · result hash ${r.recomputedResultHash}">✓ reproduced</span>`
        : `<span class="neg">✗ result changed</span> <span class="mut">${esc(r.note || '')}</span>`;
    } catch (e) { $('repro').innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
  }

  async function init() {
    $('cmpSeg').addEventListener('click', (e) => { if (e.target.dataset.v) setView(e.target.dataset.v); });
    $('saveBtn').addEventListener('click', onSave);
    $('verifyBtn').addEventListener('click', onVerify);
    $('widthChips').innerHTML = [2, 5, 10, 20, 30].map((w) => `<button type="button" data-w="${w}">±${w}%</button>`).join('');
    $('widthChips').addEventListener('click', (e) => { const w = +e.target.dataset.w; if (!w) return; setRange(S.spot * (1 - w / 100), S.spot * (1 + w / 100)); run(); });
    $('form').addEventListener('input', schedule);
    $('form').addEventListener('submit', (e) => { e.preventDefault(); run(); });
    $('themeBtn').addEventListener('click', () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; if (S.result) render(); });
    let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(draw, 150); });
    try {
      const { snapshots } = await api('GET', '/api/snapshots');
      const base = snapshots.find((x) => x.pool.address.toLowerCase() === '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640') || snapshots[0];
      S.snapshotId = base.id;
      const mk = await api('GET', `/api/snapshots/${S.snapshotId}/market`);
      S.spot = mk.market.spot.value;
      const today = base.capturedAt.slice(0, 10);
      S.history = mk.history.filter((d) => d.date < today);
      setRange(S.spot * 0.95, S.spot * 1.05);
      await run();
    } catch (e) { $('formStatus').className = 'status err'; $('formStatus').textContent = e.message; }
  }
  init();
})();
