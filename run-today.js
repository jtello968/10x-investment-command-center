// api/run-today.js
// Runs server-side only (Vercel serverless function / Node runtime).
// FINNHUB_API_KEY is read from process.env and is NEVER included in any
// response body, header, or logged value. The client never sees it.

const FINNHUB_BASE = "https://finnhub.io/api/v1";
const LIVE_THRESHOLD_MS = 20 * 60 * 1000;       // quote age <= 20 min -> LIVE
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // quote age <= 24h -> STALE, beyond -> NO DATA

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server is not configured: FINNHUB_API_KEY is missing." });
    return;
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    res.status(400).json({ error: "Invalid JSON body." });
    return;
  }

  const watchlist = Array.isArray(body.watchlist) ? body.watchlist.slice(0, 30) : [];
  const availableCash = Number(body.availableCash) || 0;
  const heldTickers = new Set(Array.isArray(body.heldTickers) ? body.heldTickers : []);

  if (watchlist.length === 0) {
    res.status(400).json({ error: "watchlist (array of {ticker, type}) is required." });
    return;
  }

  const now = Date.now();
  const companies = {};
  let liveCount = 0;
  let sumChange = 0;
  let buySignals = 0;

  await Promise.all(
    watchlist.map(async (entry) => {
      const ticker = String(entry.ticker || "").toUpperCase().trim();
      if (!ticker) return;

      if (entry.type === "private") {
        companies[ticker] = {
          status: "NO DATA",
          reason: "Marked as a private company — no public market data exists.",
          recommendation: "NO TRADE TODAY",
          suggestedAmount: 0,
        };
        return;
      }

      const [quote, metric, recTrend, news] = await Promise.all([
        fetchJson(`${FINNHUB_BASE}/quote?symbol=${ticker}&token=${apiKey}`),
        fetchJson(`${FINNHUB_BASE}/stock/metric?symbol=${ticker}&metric=all&token=${apiKey}`),
        fetchJson(`${FINNHUB_BASE}/stock/recommendation?symbol=${ticker}&token=${apiKey}`),
        fetchJson(`${FINNHUB_BASE}/company-news?symbol=${ticker}&from=${daysAgo(7)}&to=${daysAgo(0)}&token=${apiKey}`),
      ]);

      const hasPrice = quote && typeof quote.c === "number" && quote.c > 0;
      let status = "NO DATA";
      let asOf = null;

      if (hasPrice && quote.t) {
        asOf = new Date(quote.t * 1000).toISOString();
        const age = now - quote.t * 1000;
        if (age <= LIVE_THRESHOLD_MS) status = "LIVE";
        else if (age <= STALE_THRESHOLD_MS) status = "STALE";
        else status = "NO DATA";
      }

      const factors = {};
      const factorNotes = [];

      if (status !== "NO DATA") {
        // Momentum: today's % change plus position within 52-week range.
        let momentum = 50 + clamp(quote.dp, -15, 15) * 2; // -15%..+15% -> 20..80
        const hi = metric && metric.metric && metric.metric["52WeekHigh"];
        const lo = metric && metric.metric && metric.metric["52WeekLow"];
        if (typeof hi === "number" && typeof lo === "number" && hi > lo) {
          const rangePos = clamp((quote.c - lo) / (hi - lo), 0, 1) * 100;
          momentum = (momentum + rangePos) / 2;
          factorNotes.push(`Trading at ${rangePos.toFixed(0)}% of its 52-week range.`);
        }
        factors.momentum = clamp(momentum, 0, 100);

        // Valuation: trailing P/E, only if present and positive.
        const pe = metric && metric.metric && metric.metric.peTTM;
        if (typeof pe === "number" && pe > 0) {
          factors.valuation = clamp(140 - pe, 0, 100); // lower P/E scores higher; documented heuristic
          factorNotes.push(`Trailing P/E of ${pe.toFixed(1)}.`);
        }

        // Analyst sentiment: latest recommendation trend period.
        if (Array.isArray(recTrend) && recTrend.length > 0) {
          const latest = recTrend[0];
          const total = (latest.strongBuy||0)+(latest.buy||0)+(latest.hold||0)+(latest.sell||0)+(latest.strongSell||0);
          if (total > 0) {
            const bullish = (latest.strongBuy||0)+(latest.buy||0);
            const bearish = (latest.sell||0)+(latest.strongSell||0);
            factors.analystSentiment = clamp((((bullish - bearish) / total) + 1) / 2 * 100, 0, 100);
            factorNotes.push(`Analyst mix: ${latest.strongBuy||0} strong buy, ${latest.buy||0} buy, ${latest.hold||0} hold, ${latest.sell||0} sell, ${latest.strongSell||0} strong sell.`);
          }
        }
      }

      const availableFactors = Object.values(factors).filter((v) => typeof v === "number" && !isNaN(v));
      const composite = availableFactors.length
        ? Math.round(availableFactors.reduce((a, b) => a + b, 0) / availableFactors.length)
        : null;

      const isHeld = heldTickers.has(ticker);
      let recommendation = "NO TRADE TODAY";
      let reason = "";
      let confidence = "Low";
      let suggestedAmount = 0;

      if (status === "NO DATA") {
        reason = "No reliable current price data from Finnhub for this symbol.";
      } else if (composite === null) {
        recommendation = "NO TRADE TODAY";
        reason = "Price data is available but there isn't enough supporting data (valuation/analyst) to score this name today.";
      } else if (status === "STALE") {
        // Never issue BUY/SELL on stale data.
        recommendation = isHeld ? "HOLD" : "WAIT";
        reason = `Data is stale (last updated ${asOf}); holding steady rather than acting on it.`;
        confidence = "Low";
      } else {
        confidence = availableFactors.length >= 3 ? "Medium-High" : availableFactors.length === 2 ? "Medium" : "Low";
        if (composite >= 70) {
          recommendation = "BUY";
          buySignals++;
          const pctOfCash = confidence === "Medium-High" ? 0.15 : confidence === "Medium" ? 0.10 : 0.05;
          suggestedAmount = Math.max(0, Math.round(Math.min(availableCash, availableCash * pctOfCash)));
          reason = `Composite score ${composite}/100 from ${availableFactors.length} available factor(s). ${factorNotes.join(" ")}`;
        } else if (composite >= 55) {
          recommendation = isHeld ? "HOLD" : "WAIT";
          reason = `Composite score ${composite}/100 — constructive but not strong enough to size a new BUY today. ${factorNotes.join(" ")}`;
        } else if (composite >= 40) {
          recommendation = isHeld ? "HOLD" : "WAIT";
          reason = `Composite score ${composite}/100 — mixed signal. ${factorNotes.join(" ")}`;
        } else {
          recommendation = isHeld ? "SELL" : "NO TRADE TODAY";
          reason = `Composite score ${composite}/100 — weak. ${factorNotes.join(" ")}`;
        }
      }

      if (status === "LIVE") {
        liveCount++;
        sumChange += (quote.dp || 0);
      }

      companies[ticker] = {
        status,
        price: hasPrice ? quote.c : null,
        change: hasPrice ? quote.dp : null,
        asOf,
        dataSource: "Finnhub",
        score: composite,
        scoreBreakdown: factors,
        recommendation,
        suggestedAmount,
        confidence,
        risk: "High", // static per stated strategy: this watchlist is explicitly high-risk/high-upside
        reason,
        catalysts: [], // Finnhub has no structured "catalyst" feed; left empty rather than invented
        risks: pe_risk_note(metric),
        news: Array.isArray(news)
          ? news.slice(0, 3).map((n) => ({
              headline: n.headline,
              source: n.source,
              date: new Date((n.datetime || 0) * 1000).toISOString().slice(0, 10),
              summary: n.summary,
              link: n.url,
            }))
          : [],
      };
    })
  );

  let marketPosture = "NO DATA — NO TRADE TODAY";
  let whyToday = "No watchlist names returned live data on this run.";
  if (liveCount > 0) {
    const avgChange = sumChange / liveCount;
    if (avgChange <= -2) marketPosture = "CAUTION";
    else if (avgChange >= 2) marketPosture = "RISK-ON / SCALE IN";
    else marketPosture = "NEUTRAL / SELECTIVE";
    whyToday = `${liveCount} of ${watchlist.length} watchlist names have live data, averaging ${avgChange.toFixed(1)}% today, with ${buySignals} BUY signal(s).`;
  }

  res.status(200).json({
    runDate: new Date().toISOString(),
    dataSource: "Finnhub (server-side)",
    marketPosture,
    whyToday,
    whatChanged: "Computed fresh on this run from live Finnhub data — compare to your previous Run Today for deltas.",
    risksToday: "Scores are a heuristic (momentum, valuation, analyst mix) from data actually returned by Finnhub. Missing factors are excluded, not estimated.",
    watchNext: "Re-run before acting if more than a few hours have passed, especially around market open/close.",
    companies,
  });
};

function pe_risk_note(metric) {
  const pe = metric && metric.metric && metric.metric.peTTM;
  if (typeof pe === "number" && pe > 60) {
    return [`Trailing P/E of ${pe.toFixed(1)} implies the market is already pricing in significant future growth.`];
  }
  return [];
}

function clamp(n, min, max) {
  if (typeof n !== "number" || isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function fetchJson(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}
