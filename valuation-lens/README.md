# Valuation Lens

A full-stack stock metrics screener. Type comma-separated tickers (e.g. `KO, PEP, PG, WMT`) and get live valuation, quality and yield metrics in a heat-mapped table, plus interactive charts.

**Metrics:** Stock price · Book value/share · P/B · P/E (TTM) · Forward P/E · FCF yield · ROIC · EV/EBITDA · Dividend yield · 52-week low · 52-week high · 5-year high

**Visuals:** peer-relative heatmap table (toggle metrics-as-rows / tickers-as-rows, sortable), KPI medians, metric comparison bars with median line, Value-vs-Quality bubble chart (Fwd P/E vs ROIC), 52-week range positioning, FCF vs dividend yield (coverage), relative performance (6M/1Y/2Y/5Y), per-ticker detail drawer with 5-year price chart. CSV export and shareable links (`?t=KO,PEP`).

## Run locally (2 minutes)

Requires Python 3.10+.

- **Windows:** double-click `run.bat`
- **Mac/Linux:** `chmod +x run.sh && ./run.sh`

Then open http://localhost:8000

Manual: `pip install -r requirements.txt` then `uvicorn app.main:app --reload`

## Put it online so anyone can use it (free)

**Render.com**
1. Push this folder to a GitHub repo.
2. On render.com → New → Blueprint → pick the repo (it reads `render.yaml`).
3. You get a public URL like `https://valuation-lens.onrender.com`.

**Any Docker host** (Railway, Fly.io, Google Cloud Run): `docker build -t valuation-lens . && docker run -p 8000:8000 valuation-lens`

Note: free tiers sleep when idle; first load after sleep takes ~30s.

## API

| Endpoint | Description |
|---|---|
| `GET /api/metrics?tickers=KO,PEP` | All metrics for up to 30 tickers. Bad symbols return a per-ticker `error`. |
| `GET /api/history/{ticker}?period=1y` | Price history. `period`: 6mo, 1y, 2y, 5y, 10y, max |
| `GET /api/health` | Health check |
| `GET /docs` | Interactive Swagger docs |

Responses are cached 15 minutes per ticker.

## Methodology

| Metric | Formula |
|---|---|
| P/B | Price ÷ (Shareholders' equity ÷ shares) |
| P/E (TTM) | Price ÷ trailing-12-month EPS (blank if EPS ≤ 0) |
| Forward P/E | Price ÷ consensus next-FY EPS |
| FCF yield | TTM (Operating cash flow − CapEx) ÷ Market cap |
| ROIC | TTM EBIT × (1 − effective tax rate) ÷ (Total debt + Equity − Cash) |
| EV/EBITDA | (Market cap + Debt − Cash, or Yahoo EV) ÷ TTM EBITDA |
| Dividend yield | Indicated annual dividend ÷ Price (falls back to trailing 12m paid) |
| 52W / 5Y high-low | Intraday highs/lows from unadjusted daily prices |

TTM = sum of the last 4 reported quarters, falling back to the latest fiscal year. Companies with negative book value (e.g. PM, MO) get a ⚠ note: P/B is blank and ROIC is debt-heavy.

## Project layout

```
app/main.py      FastAPI app: routes, validation, caching, serves the frontend
app/metrics.py   Metric engine (yfinance → statements → computed metrics)
static/          Frontend: index.html, styles.css, app.js, vendored Chart.js
```

Data from Yahoo Finance via the unofficial `yfinance` library — fine for personal/educational use; for a commercial product swap in a licensed feed (e.g. Financial Modeling Prep, Polygon) inside `app/metrics.py`. Not investment advice.
