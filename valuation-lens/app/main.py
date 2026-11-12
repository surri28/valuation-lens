"""Valuation Lens API + static frontend."""
from __future__ import annotations

import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .metrics import PERIODS, compute_metrics, price_history

MAX_TICKERS = 30
CACHE_TTL = 15 * 60  # seconds
TICKER_RE = re.compile(r"^[A-Z0-9][A-Z0-9.\-=^]{0,14}$")

app = FastAPI(title="Valuation Lens", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])

_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=8)


def _cached(key: str, fn):
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_TTL:
            return hit[1]
    val = fn()
    with _lock:
        _cache[key] = (now, val)
    return val


def _parse(tickers: str) -> list[str]:
    out: list[str] = []
    for raw in re.split(r"[,\s;]+", tickers.upper()):
        s = raw.strip().lstrip("$")
        if not s:
            continue
        if not TICKER_RE.match(s):
            raise HTTPException(400, f"Invalid ticker: {raw!r}")
        if s not in out:
            out.append(s)
    if not out:
        raise HTTPException(400, "Provide at least one ticker, e.g. ?tickers=KO,PEP")
    if len(out) > MAX_TICKERS:
        raise HTTPException(400, f"Max {MAX_TICKERS} tickers per request")
    return out


def _one(sym: str) -> dict:
    try:
        return _cached(f"m:{sym}", lambda: compute_metrics(sym))
    except Exception as e:  # report per-ticker, don't fail the batch
        return {"ticker": sym, "error": str(e) or "Lookup failed"}


@app.get("/api/health")
def health():
    return {"ok": True, "time": datetime.now(timezone.utc).isoformat(timespec="seconds")}


@app.get("/api/metrics")
def metrics(tickers: str = Query(..., description="Comma-separated tickers, e.g. KO,PEP,PG")):
    syms = _parse(tickers)
    results = list(_pool.map(_one, syms))
    return {"asOf": datetime.now(timezone.utc).isoformat(timespec="seconds"), "results": results}


@app.get("/api/history/{ticker}")
def history(ticker: str, period: str = "1y"):
    sym = _parse(ticker)[0]
    if period not in PERIODS:
        raise HTTPException(400, f"period must be one of {list(PERIODS)}")
    try:
        return _cached(f"h:{sym}:{period}", lambda: price_history(sym, period))
    except Exception as e:
        raise HTTPException(404, str(e))


STATIC = Path(__file__).resolve().parent.parent / "static"
app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
