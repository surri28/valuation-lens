/* Valuation Lens — frontend */
(() => {
  "use strict";
  const API = (window.VL_API_BASE || "").replace(/\/$/, "");

  // ------------------------------------------------------------ metric spec
  // dir: -1 lower is more attractive, +1 higher is more attractive, 0 neutral
  const METRICS = [
    { key: "price",    label: "Stock price",      unit: "USD", fmt: "usd", dir: 0,  formula: "Last traded price", desc: "Latest regular-market price." },
    { key: "bvps",     label: "Book value/share", unit: "USD", fmt: "usd", dir: 0,  formula: "Shareholders' equity ÷ shares outstanding", desc: "Accounting net worth per share. Negative for heavy-buyback names (e.g. PM, MO)." },
    { key: "pb",       label: "P/B",              unit: "x",   fmt: "x",   dir: -1, formula: "Price ÷ Book value per share", desc: "Not meaningful when book value is negative." },
    { key: "pe",       label: "P/E (TTM)",        unit: "x",   fmt: "x",   dir: -1, formula: "Price ÷ trailing-12-month diluted EPS", desc: "Blank if EPS ≤ 0." },
    { key: "fpe",      label: "Forward P/E",      unit: "x",   fmt: "x",   dir: -1, formula: "Price ÷ consensus next-FY EPS", desc: "Uses analyst consensus EPS estimate." },
    { key: "fcfYield", label: "FCF yield",        unit: "%",   fmt: "pct", dir: 1,  formula: "TTM (Operating cash flow − CapEx) ÷ Market cap", desc: "Sum of last 4 quarters; falls back to latest fiscal year." },
    { key: "roic",     label: "ROIC",             unit: "%",   fmt: "pct", dir: 1,  formula: "TTM EBIT × (1 − effective tax) ÷ (Debt + Equity − Cash)", desc: "Effective tax rate from filings, clamped 0–50%, default 21%." },
    { key: "evEbitda", label: "EV/EBITDA",        unit: "x",   fmt: "x",   dir: -1, formula: "(Market cap + Debt − Cash) ÷ TTM EBITDA", desc: "Capital-structure-neutral valuation." },
    { key: "divYield", label: "Dividend yield",   unit: "%",   fmt: "pct", dir: 1,  formula: "Indicated annual dividend ÷ Price", desc: "Falls back to dividends paid over the trailing 12 months." },
    { key: "low52",    label: "52-week low",      unit: "USD", fmt: "usd", dir: 0,  formula: "Lowest intraday low, past 52 weeks", desc: "Unadjusted prices." },
    { key: "high52",   label: "52-week high",     unit: "USD", fmt: "usd", dir: 0,  formula: "Highest intraday high, past 52 weeks", desc: "Unadjusted prices." },
    { key: "high5y",   label: "5-year high",      unit: "USD", fmt: "usd", dir: 0,  formula: "Highest intraday high, past 5 years", desc: "Unadjusted (pre-split prices not restated by dividends)." },
  ];
  const MAP = Object.fromEntries(METRICS.map(m => [m.key, m]));
  const PALETTE = ["#34d399","#22d3ee","#a78bfa","#f472b6","#fbbf24","#60a5fa","#fb923c","#4ade80","#e879f9","#2dd4bf","#f87171","#facc15","#818cf8","#94a3b8"];

  // ------------------------------------------------------------ state
  const S = { tickers: [], data: [], errors: [], orient: "metrics", heat: true, sort: { key: null, dir: 1 }, perf: "1y", charts: {}, colors: {} };

  // ------------------------------------------------------------ dom
  const $ = s => document.querySelector(s);
  const el = (tag, attrs = {}, html = "") => { const e = document.createElement(tag); Object.assign(e, attrs); if (html) e.innerHTML = html; return e; };
  const input = $("#tickerInput"), chips = $("#chips");

  // ------------------------------------------------------------ formatting
  const fmt = (v, f) => {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    if (f === "usd") return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (f === "x") return v.toFixed(1) + "x";
    if (f === "pct") return (v * 100).toFixed(2) + "%";
    if (f === "cap") return v >= 1e12 ? "$" + (v / 1e12).toFixed(2) + "T" : v >= 1e9 ? "$" + (v / 1e9).toFixed(1) + "B" : "$" + (v / 1e6).toFixed(0) + "M";
    return String(v);
  };
  const median = arr => { const a = arr.filter(v => v != null && isFinite(v)).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2200); }

  // ------------------------------------------------------------ chips input
  function addTickers(text) {
    text.toUpperCase().split(/[\s,;]+/).map(s => s.replace(/^\$/, "").trim()).filter(Boolean).forEach(s => {
      if (!/^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/.test(s)) return toast(`Ignored "${s}"`);
      if (!S.tickers.includes(s) && S.tickers.length < 30) S.tickers.push(s);
    });
    renderChips();
  }
  function renderChips() {
    chips.querySelectorAll(".chip").forEach(c => c.remove());
    const bad = new Set(S.errors.map(e => e.ticker));
    S.tickers.forEach(t => {
      const c = el("span", { className: "chip" + (bad.has(t) ? " bad" : "") }, `${esc(t)}<button type="button" aria-label="Remove ${esc(t)}">×</button>`);
      c.querySelector("button").onclick = () => { S.tickers = S.tickers.filter(x => x !== t); renderChips(); };
      chips.insertBefore(c, input);
    });
    input.placeholder = S.tickers.length ? "Add more…" : "KO, PEP, PG, WMT, COST…";
  }
  input.addEventListener("keydown", e => {
    if ([",", " ", ";"].includes(e.key) || (e.key === "Enter" && input.value.trim())) {
      if (input.value.trim()) { e.preventDefault(); addTickers(input.value); input.value = ""; }
      else if (e.key !== "Enter") e.preventDefault();
    } else if (e.key === "Backspace" && !input.value && S.tickers.length) { S.tickers.pop(); renderChips(); }
  });
  input.addEventListener("paste", e => { e.preventDefault(); addTickers(e.clipboardData.getData("text")); });
  chips.addEventListener("click", () => input.focus());
  $("#searchForm").addEventListener("submit", e => { e.preventDefault(); if (input.value.trim()) { addTickers(input.value); input.value = ""; } run(); });
  document.querySelectorAll("[data-preset]").forEach(b => b.onclick = () => { S.tickers = []; addTickers(b.dataset.preset); run(); });

  // ------------------------------------------------------------ fetch
  async function run() {
    if (!S.tickers.length) return toast("Add at least one ticker");
    const loader = $("#loader"); $("#loaderText").textContent = `Pulling filings for ${S.tickers.length} ticker${S.tickers.length > 1 ? "s" : ""}…`;
    loader.classList.remove("hidden"); $("#goBtn").disabled = true; $("#errorBar").classList.add("hidden");
    try {
      const r = await fetch(`${API}/api/metrics?tickers=${encodeURIComponent(S.tickers.join(","))}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || "Request failed");
      S.data = j.results.filter(x => !x.error);
      S.errors = j.results.filter(x => x.error);
      S.colors = Object.fromEntries(S.data.map((d, i) => [d.ticker, PALETTE[i % PALETTE.length]]));
      S.asOf = j.asOf;
      history.replaceState(null, "", `?t=${S.tickers.join(",")}`);
      if (S.errors.length) { const eb = $("#errorBar"); eb.textContent = "Couldn't load: " + S.errors.map(e => e.ticker).join(", ") + " — check the symbol(s)."; eb.classList.remove("hidden"); }
      renderChips();
      render();
    } catch (err) {
      const eb = $("#errorBar"); eb.textContent = "Error: " + err.message; eb.classList.remove("hidden");
    } finally { loader.classList.add("hidden"); $("#goBtn").disabled = false; }
  }

  // ------------------------------------------------------------ heat
  function heatColor(key, v) {
    const m = MAP[key]; if (!S.heat || !m.dir || v == null) return "";
    const vals = S.data.map(d => d.metrics[key]).filter(x => x != null).sort((a, b) => a - b);
    if (vals.length < 2) return "";
    const rank = vals.indexOf(v) / (vals.length - 1);
    const score = m.dir > 0 ? rank : 1 - rank; // 1 = most attractive
    const a = Math.abs(score - 0.5) * 2 * 0.38;
    return `background-color: rgba(${score >= 0.5 ? "var(--good)" : "var(--bad)"}, ${a.toFixed(3)})`;
  }

  function spark(arr, w = 90, h = 26) {
    if (!arr || arr.length < 2) return "";
    const mn = Math.min(...arr), mx = Math.max(...arr), r = mx - mn || 1;
    const pts = arr.map((v, i) => `${(i / (arr.length - 1) * w).toFixed(1)},${(h - 2 - (v - mn) / r * (h - 4)).toFixed(1)}`).join(" ");
    const up = arr[arr.length - 1] >= arr[0];
    const c = up ? "#34d399" : "#f87171";
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  }

  // ------------------------------------------------------------ render
  function render() {
    const has = S.data.length > 0;
    $("#empty").classList.toggle("hidden", has);
    $("#results").classList.toggle("hidden", !has);
    if (!has) return;
    $("#asOf").textContent = `${S.data.length} companies · as of ${new Date(S.asOf).toLocaleString()} · all values in USD`;
    renderKPIs(); renderTable(); renderBar(); renderScatter(); renderRanges(); renderYield(); renderPerf();
  }

  function renderKPIs() {
    const best = (key, dir) => { const arr = S.data.filter(d => d.metrics[key] != null); if (!arr.length) return null; return arr.reduce((a, b) => (dir > 0 ? b.metrics[key] > a.metrics[key] : b.metrics[key] < a.metrics[key]) ? b : a); };
    const items = [
      ["Median P/E", fmt(median(S.data.map(d => d.metrics.pe)), "x"), "pe", -1],
      ["Median Fwd P/E", fmt(median(S.data.map(d => d.metrics.fpe)), "x"), "fpe", -1],
      ["Median EV/EBITDA", fmt(median(S.data.map(d => d.metrics.evEbitda)), "x"), "evEbitda", -1],
      ["Median FCF yield", fmt(median(S.data.map(d => d.metrics.fcfYield)), "pct"), "fcfYield", 1],
      ["Median ROIC", fmt(median(S.data.map(d => d.metrics.roic)), "pct"), "roic", 1],
      ["Median div. yield", fmt(median(S.data.map(d => d.metrics.divYield)), "pct"), "divYield", 1],
    ];
    $("#kpis").innerHTML = items.map(([k, v, key, dir], i) => {
      const b = best(key, dir);
      return `<div class="kpi" style="animation-delay:${i * 40}ms"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${dir < 0 ? "Cheapest" : "Best"}: ${b ? `<b>${esc(b.ticker)}</b> ${fmt(b.metrics[key], MAP[key].fmt)}` : "—"}</div></div>`;
    }).join("");
  }

  function warn(d) { return d.notes && d.notes.length ? `<span class="warn-ic" title="${esc(d.notes.join(" "))}">⚠</span>` : ""; }

  function sortedData() {
    const { key, dir } = S.sort; if (!key) return S.data;
    return [...S.data].sort((a, b) => {
      const va = key === "ticker" ? a.ticker : a.metrics[key], vb = key === "ticker" ? b.ticker : b.metrics[key];
      if (va == null) return 1; if (vb == null) return -1;
      return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
    });
  }

  function renderTable() {
    const tbl = $("#table"); const data = sortedData();
    if (S.orient === "metrics") {
      let h = `<thead><tr><th>Metric</th>${data.map(d => `<th><button class="tk" data-t="${esc(d.ticker)}">${esc(d.ticker)}</button>${warn(d)}<span class="tk-name">${esc(d.name)}</span></th>`).join("")}<th class="med">Peer median</th></tr></thead><tbody>`;
      for (const m of METRICS) {
        h += `<tr><td class="metric-name">${m.label}<small>${m.unit}</small></td>`;
        for (const d of data) { const v = d.metrics[m.key]; h += `<td class="num ${v == null ? "na" : ""}" style="${heatColor(m.key, v)}">${fmt(v, m.fmt)}</td>`; }
        h += `<td class="num med">${m.dir ? fmt(median(S.data.map(d => d.metrics[m.key])), m.fmt) : ""}</td></tr>`;
      }
      h += `<tr><td class="metric-name">1Y trend<small>weekly close</small></td>${data.map(d => `<td>${spark(d.spark)}</td>`).join("")}<td></td></tr>`;
      tbl.innerHTML = h + "</tbody>";
    } else {
      const ar = k => `<span class="arr">${S.sort.key === k ? (S.sort.dir > 0 ? "▲" : "▼") : "↕"}</span>`;
      let h = `<thead><tr><th class="sortable ${S.sort.key === "ticker" ? "sorted" : ""}" data-k="ticker">Ticker${ar("ticker")}</th>${METRICS.map(m => `<th class="sortable ${S.sort.key === m.key ? "sorted" : ""}" data-k="${m.key}" title="${esc(m.formula)}">${m.label}${ar(m.key)}</th>`).join("")}<th>1Y</th></tr></thead><tbody>`;
      for (const d of data) {
        h += `<tr><td><button class="tk" data-t="${esc(d.ticker)}">${esc(d.ticker)}</button>${warn(d)}<span class="tk-name">${esc(d.name)}</span></td>`;
        for (const m of METRICS) { const v = d.metrics[m.key]; h += `<td class="num ${v == null ? "na" : ""}" style="${heatColor(m.key, v)}">${fmt(v, m.fmt)}</td>`; }
        h += `<td>${spark(d.spark)}</td></tr>`;
      }
      h += `<tr class="row-med"><td class="med">Peer median</td>${METRICS.map(m => `<td class="num med">${m.dir ? fmt(median(S.data.map(d => d.metrics[m.key])), m.fmt) : ""}</td>`).join("")}<td></td></tr>`;
      tbl.innerHTML = h + "</tbody>";
      tbl.querySelectorAll("th.sortable").forEach(th => th.onclick = () => {
        const k = th.dataset.k; S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (MAP[k] && MAP[k].dir > 0 ? -1 : 1) }; renderTable();
      });
    }
    tbl.querySelectorAll(".tk").forEach(b => b.onclick = () => openDrawer(b.dataset.t));
  }

  // ------------------------------------------------------------ charts
  Chart.defaults.color = "#8592a8";
  Chart.defaults.font.family = "Inter, system-ui, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.borderColor = "rgba(148,163,184,0.1)";
  const tip = { backgroundColor: "#0b1220", borderColor: "rgba(148,163,184,.25)", borderWidth: 1, padding: 10, titleFont: { family: "'IBM Plex Mono', ui-monospace, monospace", weight: "600" }, bodyFont: { family: "'IBM Plex Mono', ui-monospace, monospace" } };
  const mk = (id, cfg) => { if (S.charts[id]) S.charts[id].destroy(); S.charts[id] = new Chart(document.getElementById(id), cfg); return S.charts[id]; };
  const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

  const sel = $("#metricSelect");
  sel.innerHTML = METRICS.filter(m => m.dir).map(m => `<option value="${m.key}">${m.label}</option>`).join("");
  sel.value = "fpe";
  sel.onchange = renderBar;

  const medianLine = {
    id: "medianLine",
    afterDatasetsDraw(chart, _a, opts) {
      if (opts.value == null) return;
      const { ctx, chartArea: { top, bottom }, scales: { x } } = chart;
      const px = x.getPixelForValue(opts.value);
      ctx.save(); ctx.strokeStyle = "#22d3ee"; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = "#22d3ee"; ctx.font = "600 11px 'IBM Plex Mono', monospace"; ctx.textAlign = "left";
      ctx.fillText("median " + opts.label, px + 6, top + 10); ctx.restore();
    }
  };

  function renderBar() {
    const m = MAP[sel.value];
    const rows = S.data.filter(d => d.metrics[m.key] != null).sort((a, b) => m.dir > 0 ? b.metrics[m.key] - a.metrics[m.key] : a.metrics[m.key] - b.metrics[m.key]);
    const scale = m.fmt === "pct" ? 100 : 1;
    const med = median(rows.map(d => d.metrics[m.key]));
    mk("barChart", {
      type: "bar",
      data: { labels: rows.map(d => d.ticker), datasets: [{ data: rows.map(d => d.metrics[m.key] * scale), backgroundColor: rows.map(d => hexA(S.colors[d.ticker], .75)), borderColor: rows.map(d => S.colors[d.ticker]), borderWidth: 1, borderRadius: 6, barThickness: "flex", maxBarThickness: 22 }] },
      options: {
        indexAxis: "y", maintainAspectRatio: false, animation: { duration: 700, easing: "easeOutQuart" },
        plugins: { legend: { display: false }, tooltip: { ...tip, callbacks: { label: c => ` ${m.label}: ${fmt(c.raw / scale, m.fmt)}` } }, medianLine: { value: med == null ? null : med * scale, label: fmt(med, m.fmt) } },
        scales: { x: { grid: { color: "rgba(148,163,184,.08)" }, ticks: { callback: v => m.fmt === "pct" ? v + "%" : m.fmt === "x" ? v + "x" : v } }, y: { grid: { display: false }, ticks: { font: { family: "'IBM Plex Mono', ui-monospace, monospace", weight: "600" }, color: "#e6ebf5" } } },
        onClick: (_e, els) => els.length && openDrawer(rows[els[0].index].ticker),
      },
      plugins: [medianLine],
    });
  }

  const quadLabels = {
    id: "quad",
    beforeDatasetsDraw(chart, _a, o) {
      if (o.x == null || o.y == null) return;
      const { ctx, chartArea: a, scales: { x, y } } = chart;
      const px = x.getPixelForValue(o.x), py = y.getPixelForValue(o.y);
      if (px < a.left || px > a.right || py < a.top || py > a.bottom) return;
      ctx.save();
      ctx.fillStyle = "rgba(52,211,153,.05)"; ctx.fillRect(a.left, a.top, px - a.left, py - a.top);
      ctx.strokeStyle = "rgba(148,163,184,.25)"; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke();
      ctx.setLineDash([]); ctx.font = "600 10.5px Inter"; ctx.fillStyle = "rgba(52,211,153,.8)";
      ctx.fillText("CHEAP + HIGH QUALITY", a.left + 8, a.top + 14);
      ctx.fillStyle = "rgba(248,113,113,.7)"; ctx.textAlign = "right"; ctx.fillText("EXPENSIVE + LOWER QUALITY", a.right - 8, a.bottom - 8);
      ctx.restore();
    }
  };

  function renderScatter() {
    const rows = S.data.filter(d => d.metrics.fpe != null && d.metrics.roic != null);
    const caps = rows.map(d => d.marketCap || 0); const maxCap = Math.max(...caps, 1);
    mk("scatterChart", {
      type: "bubble",
      data: { datasets: rows.map(d => ({ label: d.ticker, data: [{ x: d.metrics.fpe, y: d.metrics.roic * 100, r: 6 + 18 * Math.sqrt((d.marketCap || 0) / maxCap) }], backgroundColor: hexA(S.colors[d.ticker], .45), borderColor: S.colors[d.ticker], borderWidth: 1.5 })) },
      options: {
        maintainAspectRatio: false, animation: { duration: 700 },
        plugins: {
          legend: { display: false },
          quad: { x: median(rows.map(d => d.metrics.fpe)), y: median(rows.map(d => d.metrics.roic * 100)) },
          tooltip: { ...tip, callbacks: { label: c => { const d = rows[c.datasetIndex]; return ` ${d.ticker}  Fwd P/E ${fmt(d.metrics.fpe, "x")} · ROIC ${fmt(d.metrics.roic, "pct")} · ${fmt(d.marketCap, "cap")}`; } } },
        },
        scales: { x: { title: { display: true, text: "Forward P/E (x) →  more expensive" }, grid: { color: "rgba(148,163,184,.08)" } }, y: { title: { display: true, text: "ROIC (%) ↑" }, grid: { color: "rgba(148,163,184,.08)" }, ticks: { callback: v => v + "%" } } },
        onClick: (_e, els) => els.length && openDrawer(rows[els[0].datasetIndex].ticker),
      },
      plugins: [quadLabels, {
        id: "lbl", afterDatasetsDraw(chart) {
          const { ctx } = chart; ctx.save(); ctx.font = "600 11px 'IBM Plex Mono', monospace"; ctx.fillStyle = "#e6ebf5"; ctx.textAlign = "center";
          chart.data.datasets.forEach((ds, i) => { const p = chart.getDatasetMeta(i).data[0]; if (p) ctx.fillText(ds.label, p.x, p.y - ds.data[0].r - 4); });
          ctx.restore();
        }
      }],
    });
  }

  function renderRanges() {
    const rows = [...S.data].sort((a, b) => (b.derived.rangePos52 ?? 0) - (a.derived.rangePos52 ?? 0));
    $("#ranges").innerHTML = rows.map(d => {
      const pos = Math.max(0, Math.min(1, d.derived.rangePos52 ?? 0.5)) * 100;
      const o52 = d.derived.offHigh52, o5 = d.derived.offHigh5y;
      return `<div class="rg"><div class="t" data-t="${esc(d.ticker)}">${esc(d.ticker)}</div>
        <div class="track"><div class="mk" style="left:0" data-left="${pos}"></div><span class="lo">${fmt(d.metrics.low52, "usd")}</span><span class="hi">${fmt(d.metrics.high52, "usd")}</span></div>
        <div class="d"><b class="${o52 < -0.001 ? "neg" : "pos"}">${o52 == null ? "—" : (o52 * 100).toFixed(1) + "%"}</b> vs 52W hi<span>${o5 == null ? "—" : (o5 * 100).toFixed(1) + "%"} vs 5Y hi</span></div></div>`;
    }).join("");
    requestAnimationFrame(() => document.querySelectorAll(".track .mk").forEach(m => m.style.left = m.dataset.left + "%"));
    document.querySelectorAll(".rg .t").forEach(t => t.onclick = () => openDrawer(t.dataset.t));
  }

  function renderYield() {
    const rows = [...S.data].sort((a, b) => (b.metrics.fcfYield ?? -1) - (a.metrics.fcfYield ?? -1));
    mk("yieldChart", {
      type: "bar",
      data: {
        labels: rows.map(d => d.ticker),
        datasets: [
          { label: "FCF yield", data: rows.map(d => d.metrics.fcfYield == null ? null : d.metrics.fcfYield * 100), backgroundColor: "rgba(52,211,153,.75)", borderRadius: 5, maxBarThickness: 18 },
          { label: "Dividend yield", data: rows.map(d => d.metrics.divYield == null ? null : d.metrics.divYield * 100), backgroundColor: "rgba(167,139,250,.75)", borderRadius: 5, maxBarThickness: 18 },
        ],
      },
      options: {
        maintainAspectRatio: false, animation: { duration: 700 },
        plugins: { legend: { position: "top", align: "end", labels: { boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 3 } },
          tooltip: { ...tip, callbacks: { label: c => ` ${c.dataset.label}: ${c.raw == null ? "—" : c.raw.toFixed(2) + "%"}`, afterBody: items => { const d = rows[items[0].dataIndex]; const f = d.metrics.fcfYield, y = d.metrics.divYield; return f && y ? `Coverage: ${(f / y).toFixed(2)}x` : ""; } } } },
        scales: { x: { grid: { display: false }, ticks: { font: { family: "'IBM Plex Mono', ui-monospace, monospace", weight: "600" }, color: "#e6ebf5" } }, y: { grid: { color: "rgba(148,163,184,.08)" }, ticks: { callback: v => v + "%" } } },
        onClick: (_e, els) => els.length && openDrawer(rows[els[0].index].ticker),
      },
    });
  }

  async function getHistory(t, period) {
    const r = await fetch(`${API}/api/history/${encodeURIComponent(t)}?period=${period}`);
    if (!r.ok) throw new Error("history"); return r.json();
  }

  let perfToken = 0;
  async function renderPerf() {
    const token = ++perfToken; const period = S.perf;
    const hs = await Promise.all(S.data.map(d => getHistory(d.ticker, period).catch(() => null)));
    if (token !== perfToken) return;
    const datasets = hs.filter(Boolean).map(h => {
      const base = h.close[0];
      return { label: h.ticker, data: h.dates.map((dt, i) => ({ x: Date.parse(dt), y: (h.close[i] / base - 1) * 100 })), borderColor: S.colors[h.ticker], backgroundColor: S.colors[h.ticker], borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 4, tension: .15 };
    });
    const long = ["2y", "5y"].includes(period);
    mk("perfChart", {
      type: "line", data: { datasets },
      options: {
        maintainAspectRatio: false, animation: { duration: 600 }, interaction: { mode: "nearest", axis: "x", intersect: false },
        plugins: { legend: { position: "top", align: "end", labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: "rectRounded" } },
          tooltip: { ...tip, mode: "index", intersect: false, itemSort: (a, b) => b.raw.y - a.raw.y, callbacks: { title: it => new Date(it[0].raw.x).toLocaleDateString(), label: c => ` ${c.dataset.label}: ${c.raw.y >= 0 ? "+" : ""}${c.raw.y.toFixed(1)}%` } } },
        scales: {
          x: { type: "linear", grid: { color: "rgba(148,163,184,.06)" }, ticks: { maxTicksLimit: 8, callback: v => new Date(v).toLocaleDateString(undefined, long ? { year: "numeric", month: "short" } : { month: "short", day: "numeric" }) } },
          y: { grid: { color: "rgba(148,163,184,.08)" }, ticks: { callback: v => (v > 0 ? "+" : "") + v + "%" } },
        },
      },
    });
  }

  // ------------------------------------------------------------ drawer
  async function openDrawer(t) {
    const d = S.data.find(x => x.ticker === t); if (!d) return;
    const m = d.metrics, med = k => median(S.data.map(x => x.metrics[k]));
    const cell = (k) => { const s = MAP[k]; const md = s.dir ? med(k) : null; return `<div class="dr-cell"><div class="k">${s.label}</div><div class="v">${fmt(m[k], s.fmt)}</div>${md != null && S.data.length > 1 ? `<div class="r">peer median ${fmt(md, s.fmt)}</div>` : `<div class="r">&nbsp;</div>`}</div>`; };
    const o52 = d.derived.offHigh52;
    $("#drawerBody").innerHTML = `
      <div class="dr-head"><h3 style="color:${S.colors[t]}">${esc(t)}</h3><div class="nm">${esc(d.name)}${d.industry ? " · " + esc(d.industry) : ""}</div></div>
      <div class="dr-price">${fmt(m.price, "usd")}</div>
      <div class="muted">Market cap ${fmt(d.marketCap, "cap")} · <span class="${o52 < 0 ? "neg" : "pos"}">${o52 == null ? "" : (o52 * 100).toFixed(1) + "% from 52W high"}</span> · 5Y high set ${esc(d.derived.high5yDate)}</div>
      <div class="dr-chart"><canvas id="drChart"></canvas></div>
      <div class="dr-grid">${METRICS.filter(x => x.key !== "price").map(x => cell(x.key)).join("")}</div>
      ${d.notes.length ? `<div class="dr-notes">${d.notes.map(n => `<p>⚠ ${esc(n)}</p>`).join("")}</div>` : ""}
      <p class="muted" style="margin-top:14px">Effective tax rate used for ROIC: ${(d.derived.taxRateUsed * 100).toFixed(1)}% · TTM FCF ${fmt(d.derived.fcf, "cap")} · TTM EBITDA ${fmt(d.derived.ebitda, "cap")}</p>`;
    $("#drawer").classList.add("open"); $("#drawerBg").classList.remove("hidden"); $("#drawer").setAttribute("aria-hidden", "false");
    try {
      const h = await getHistory(t, "5y");
      const c = S.colors[t];
      mk("drChart", {
        type: "line",
        data: { labels: h.dates, datasets: [{ data: h.close, borderColor: c, borderWidth: 2, pointRadius: 0, fill: true, tension: .2,
          backgroundColor: ctx => { const { chartArea: a, ctx: g } = ctx.chart; if (!a) return hexA(c, .1); const gr = g.createLinearGradient(0, a.top, 0, a.bottom); gr.addColorStop(0, hexA(c, .35)); gr.addColorStop(1, hexA(c, 0)); return gr; } }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { ...tip, intersect: false, mode: "index", callbacks: { label: x => " $" + x.raw.toFixed(2) } } },
          scales: { x: { ticks: { maxTicksLimit: 6, callback: function (v) { return this.getLabelForValue(v).slice(0, 7); } }, grid: { display: false } }, y: { grid: { color: "rgba(148,163,184,.08)" }, ticks: { callback: v => "$" + v } } } },
      });
    } catch { /* chart optional */ }
  }
  const closeDrawer = () => { $("#drawer").classList.remove("open"); $("#drawerBg").classList.add("hidden"); $("#drawer").setAttribute("aria-hidden", "true"); };
  $("#drawerX").onclick = closeDrawer; $("#drawerBg").onclick = closeDrawer;
  document.addEventListener("keydown", e => e.key === "Escape" && closeDrawer());

  // ------------------------------------------------------------ toolbar
  document.querySelectorAll("#orientSeg button").forEach(b => b.onclick = () => {
    document.querySelectorAll("#orientSeg button").forEach(x => x.classList.toggle("on", x === b)); S.orient = b.dataset.v; renderTable();
  });
  document.querySelectorAll("#perfSeg button").forEach(b => b.onclick = () => {
    document.querySelectorAll("#perfSeg button").forEach(x => x.classList.toggle("on", x === b)); S.perf = b.dataset.v; renderPerf();
  });
  $("#heatToggle").onchange = e => { S.heat = e.target.checked; renderTable(); };

  $("#csvBtn").onclick = () => {
    const rows = [["Ticker", "Name", ...METRICS.map(m => `${m.label} (${m.unit})`)]];
    S.data.forEach(d => rows.push([d.ticker, d.name, ...METRICS.map(m => { const v = d.metrics[m.key]; return v == null ? "" : m.fmt === "pct" ? (v * 100).toFixed(4) : v.toFixed(4); })]));
    const csv = rows.map(r => r.map(c => /[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c).join(",")).join("\n");
    const a = el("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: `valuation-lens-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.appendChild(a); a.click(); a.remove(); toast("CSV downloaded");
  };
  $("#shareBtn").onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Link copied"); } catch { toast(location.href); }
  };

  $("#methodGrid").innerHTML = METRICS.map(m => `<div class="m-item"><b>${m.label}</b><code>${esc(m.formula)}</code><p>${esc(m.desc)}</p></div>`).join("");

  // ------------------------------------------------------------ boot
  fetch(`${API}/api/health`).then(r => r.ok ? r.json() : Promise.reject()).then(() => {
    $("#statusDot").className = "dot ok"; $("#statusText").textContent = "Live data";
  }).catch(() => { $("#statusDot").className = "dot err"; $("#statusText").textContent = "API offline"; });

  const q = new URLSearchParams(location.search).get("t");
  if (q) { addTickers(q); run(); } else { renderChips(); }
})();
