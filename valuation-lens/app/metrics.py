"""Metric engine: pulls raw data from Yahoo Finance (via yfinance) and computes
valuation / quality metrics consistently, falling back to Yahoo's own figures
only when the raw statements are missing."""
from __future__ import annotations

import math
from datetime import datetime, timezone

import pandas as pd
import yfinance as yf

DEFAULT_TAX = 0.21


# ----------------------------------------------------------------- helpers
def _num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if (math.isnan(v) or math.isinf(v)) else v


def _row(df: pd.DataFrame | None, names: list[str]):
    if df is None or getattr(df, "empty", True):
        return None
    for n in names:
        if n in df.index:
            s = df.loc[n]
            if isinstance(s, pd.DataFrame):
                s = s.iloc[0]
            s = pd.to_numeric(s, errors="coerce").dropna()
            if len(s):
                return s.sort_index(ascending=False)  # most recent first
    return None


def _ttm(q: pd.DataFrame | None, a: pd.DataFrame | None, names: list[str]):
    """Trailing-twelve-month value: sum of the last 4 quarters, else latest fiscal year."""
    s = _row(q, names)
    if s is not None and len(s) >= 4:
        return float(s.iloc[:4].sum())
    s = _row(a, names)
    if s is not None:
        return float(s.iloc[0])
    return None


def _latest(q: pd.DataFrame | None, a: pd.DataFrame | None, names: list[str]):
    """Most recent balance-sheet value (quarterly first, then annual)."""
    for df in (q, a):
        s = _row(df, names)
        if s is not None:
            return float(s.iloc[0])
    return None


def _safe(fn):
    try:
        return fn()
    except Exception:
        return None


def _div(a, b, positive_denominator=True):
    if a is None or b is None or b == 0:
        return None
    if positive_denominator and b < 0:
        return None
    return a / b


# ----------------------------------------------------------------- main
def compute_metrics(symbol: str) -> dict:
    t = yf.Ticker(symbol)
    info = _safe(lambda: t.info) or {}
    hist = _safe(lambda: t.history(period="5y", interval="1d", auto_adjust=False))
    if hist is None or hist.empty:
        raise ValueError(f"No price data found for '{symbol}'")

    notes: list[str] = []
    last_close = float(hist["Close"].iloc[-1])
    price = _num(info.get("currentPrice")) or _num(info.get("regularMarketPrice")) or last_close

    # ----- price ranges
    end = hist.index[-1]
    yr = hist[hist.index >= end - pd.DateOffset(years=1)]
    low52 = float(yr["Low"].min())
    high52 = float(yr["High"].max())
    high5 = float(hist["High"].max())
    high5_date = hist["High"].idxmax().strftime("%Y-%m-%d")
    low52 = min(low52, price)
    high52 = max(high52, price)
    high5 = max(high5, price)
    years_covered = (end - hist.index[0]).days / 365.25
    if years_covered < 4.8:
        notes.append(f"Only {years_covered:.1f}y of price history; '5Y high' covers that span.")

    # ----- statements
    qis = _safe(lambda: t.quarterly_income_stmt)
    ais = _safe(lambda: t.income_stmt)
    qbs = _safe(lambda: t.quarterly_balance_sheet)
    abs_ = _safe(lambda: t.balance_sheet)
    qcf = _safe(lambda: t.quarterly_cashflow)
    acf = _safe(lambda: t.cashflow)

    shares = (
        _num(info.get("sharesOutstanding"))
        or _num(info.get("impliedSharesOutstanding"))
        or _latest(qbs, abs_, ["Ordinary Shares Number", "Share Issued"])
    )
    mcap = _num(info.get("marketCap")) or (price * shares if shares else None)

    equity = _latest(qbs, abs_, ["Stockholders Equity", "Common Stock Equity"])
    debt = _latest(qbs, abs_, ["Total Debt"]) or 0.0
    cash = _latest(qbs, abs_, [
        "Cash Cash Equivalents And Short Term Investments",
        "Cash And Cash Equivalents",
    ]) or 0.0

    # Book value / share & P/B
    bvps = _num(info.get("bookValue"))
    if bvps is None and equity is not None and shares:
        bvps = equity / shares
    pb = _div(price, bvps)
    if bvps is not None and bvps <= 0:
        notes.append("Negative book value (buybacks/debt): P/B not meaningful, ROIC base is debt-heavy.")

    # P/E (TTM)
    eps = _num(info.get("trailingEps"))
    if eps is None:
        ni = _ttm(qis, ais, ["Net Income Common Stockholders", "Net Income"])
        eps = _div(ni, shares)
    pe = _div(price, eps)
    if eps is not None and eps <= 0:
        notes.append("Negative trailing EPS: P/E not meaningful.")

    # Forward P/E
    feps = _num(info.get("forwardEps"))
    fpe = _div(price, feps) if feps else _num(info.get("forwardPE"))
    if fpe is not None and fpe <= 0:
        fpe = None

    # FCF yield
    fcf = _ttm(qcf, acf, ["Free Cash Flow"])
    if fcf is None:
        ocf = _ttm(qcf, acf, ["Operating Cash Flow"])
        capex = _ttm(qcf, acf, ["Capital Expenditure"])
        if ocf is not None:
            fcf = ocf + (capex or 0.0)  # capex is reported negative
    if fcf is None:
        fcf = _num(info.get("freeCashflow"))
        if fcf is not None:
            notes.append("FCF from Yahoo summary (statements unavailable).")
    fcf_yield = _div(fcf, mcap)

    # ROIC = NOPAT / (Debt + Equity - Cash)
    ebit = _ttm(qis, ais, ["EBIT", "Operating Income"])
    pretax = _ttm(qis, ais, ["Pretax Income"])
    tax = _ttm(qis, ais, ["Tax Provision"])
    tax_rate = DEFAULT_TAX
    if pretax and pretax > 0 and tax is not None:
        tax_rate = min(max(tax / pretax, 0.0), 0.5)
    invested = (debt or 0) + (equity or 0) - (cash or 0) if equity is not None else None
    roic = None
    if ebit is not None and invested and invested > 0:
        roic = ebit * (1 - tax_rate) / invested

    # EV / EBITDA
    ev = _num(info.get("enterpriseValue"))
    if ev is None and mcap is not None:
        ev = mcap + debt - cash
    ebitda = _ttm(qis, ais, ["EBITDA", "Normalized EBITDA"]) or _num(info.get("ebitda"))
    ev_ebitda = _div(ev, ebitda)

    # Dividend yield (forward rate, else trailing 12m paid)
    rate = _num(info.get("dividendRate"))
    divs = _safe(lambda: t.dividends)
    ttm_div = None
    if divs is not None and len(divs):
        cutoff = end - pd.DateOffset(years=1)
        ttm_div = float(divs[divs.index > cutoff].sum())
    annual_div = rate if rate else ttm_div
    div_yield = _div(annual_div, price) if annual_div else 0.0

    # Weekly sparkline (1y)
    spark = yr["Close"].resample("W").last().dropna()

    return {
        "ticker": symbol,
        "name": info.get("shortName") or info.get("longName") or symbol,
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "currency": info.get("currency") or "USD",
        "marketCap": mcap,
        "metrics": {
            "price": price,
            "bvps": bvps,
            "pb": pb,
            "pe": pe,
            "fpe": fpe,
            "fcfYield": fcf_yield,
            "roic": roic,
            "evEbitda": ev_ebitda,
            "divYield": div_yield,
            "low52": low52,
            "high52": high52,
            "high5y": high5,
        },
        "derived": {
            "high5yDate": high5_date,
            "offHigh52": _div(price - high52, high52),
            "offHigh5y": _div(price - high5, high5),
            "rangePos52": _div(price - low52, high52 - low52) if high52 > low52 else None,
            "taxRateUsed": tax_rate,
            "fcf": fcf,
            "ebitda": ebitda,
            "ev": ev,
        },
        "spark": [round(float(v), 2) for v in spark.tolist()],
        "notes": notes,
        "asOf": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


PERIODS = {"6mo": "1d", "1y": "1d", "2y": "1wk", "5y": "1wk", "10y": "1mo", "max": "1mo"}


def price_history(symbol: str, period: str = "1y") -> dict:
    interval = PERIODS.get(period, "1d")
    h = yf.Ticker(symbol).history(period=period, interval=interval, auto_adjust=True)
    if h.empty:
        raise ValueError(f"No history for '{symbol}'")
    closes = h["Close"].dropna()
    return {
        "ticker": symbol,
        "period": period,
        "dates": [d.strftime("%Y-%m-%d") for d in closes.index],
        "close": [round(float(v), 4) for v in closes.tolist()],
    }
