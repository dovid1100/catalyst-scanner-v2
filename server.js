const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const POLYGON_KEY = process.env.POLYGON_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

app.use(cors());
app.use(express.json());

// ─── Data Layer ───────────────────────────────────────────────────────────────

async function loadData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      picks: [],        // daily pick sets
      signals: [],      // all individual stock signals ever considered
      learningLog: [],  // what the AI learned from each outcome
      stats: {
        totalPicks: 0,
        correctPicks: 0, // hit 20%+
        winRate: 0,
        avgMove: 0,
        bySignalType: {}
      }
    };
  }
}

async function saveData(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── HTTP Helper ──────────────────────────────────────────────────────────────

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'CatalystScanner/2.0',
        'Accept': 'application/json',
        ...options.headers
      },
      timeout: 20000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, options).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ─── Polygon.io API ───────────────────────────────────────────────────────────

async function polygonGet(endpoint) {
  const url = `https://api.polygon.io${endpoint}${endpoint.includes('?') ? '&' : '?'}apiKey=${POLYGON_KEY}`;
  const res = await fetchUrl(url);
  if (res.status !== 200) {
    throw new Error(`Polygon API error ${res.status}: ${endpoint}`);
  }
  return JSON.parse(res.body);
}

// Get all small-cap stocks on Nasdaq/NYSE under $300M market cap
async function getSmallCapUniverse() {
  try {
    const stocks = [];
    let nextUrl = null;
    let page = 0;
    const maxPages = 5;

    do {
      const endpoint = nextUrl
        ? nextUrl.replace('https://api.polygon.io', '')
        : `/v3/reference/tickers?market=stocks&exchange=XNAS,XNYS&active=true&limit=250&sort=market_cap&order=desc`;

      const data = await polygonGet(endpoint);
      const results = data.results || [];

      for (const stock of results) {
        const cap = stock.market_cap || 0;
        if (cap > 300_000_000) continue; // skip large caps
        if (cap < 10_000_000) continue;  // skip sub $10M junk
        stocks.push({
          ticker: stock.ticker,
          name: stock.name,
          marketCap: cap,
          exchange: stock.primary_exchange
        });
      }

      nextUrl = data.next_url || null;
      page++;
    } while (nextUrl && page < maxPages);

    console.log(`Universe: ${stocks.length} small-cap stocks found`);
    return stocks;
  } catch (e) {
    console.error('Universe error:', e.message);
    return [];
  }
}

// Get previous day snapshot for a ticker
async function getTickerSnapshot(ticker) {
  try {
    const data = await polygonGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
    const snap = data.ticker;
    if (!snap) return null;

    const day = snap.day || {};
    const prevDay = snap.prevDay || {};
    const lastTrade = snap.lastTrade || {};

    return {
      ticker,
      price: snap.lastTrade?.p || day.c || prevDay.c || 0,
      open: day.o || prevDay.o || 0,
      high: day.h || prevDay.h || 0,
      low: day.l || prevDay.l || 0,
      close: day.c || prevDay.c || 0,
      volume: day.v || prevDay.v || 0,
      vwap: day.vw || prevDay.vw || 0,
      prevClose: prevDay.c || 0,
      todayChange: snap.todaysChangePerc || 0,
      volumeAvg: null // filled below
    };
  } catch (e) {
    return null;
  }
}

// Get average volume over last 20 days
async function getAvgVolume(ticker) {
  try {
    const to = getPrevTradingDay();
    const from = getDateDaysAgo(30);
    const data = await polygonGet(`/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=desc&limit=20`);
    const results = data.results || [];
    if (results.length === 0) return 0;
    const avg = results.reduce((a, b) => a + b.v, 0) / results.length;
    return Math.round(avg);
  } catch (e) {
    return 0;
  }
}

// Get recent news for a ticker
async function getTickerNews(ticker) {
  try {
    const data = await polygonGet(`/v2/reference/news?ticker=${ticker}&limit=5&order=desc&sort=published_utc`);
    return (data.results || []).map(n => ({
      title: n.title,
      summary: n.description || '',
      published: n.published_utc,
      url: n.article_url
    }));
  } catch (e) {
    return [];
  }
}

// Get recent financials / fundamentals
async function getTickerDetails(ticker) {
  try {
    const data = await polygonGet(`/v3/reference/tickers/${ticker}`);
    const r = data.results || {};
    return {
      name: r.name,
      description: r.description || '',
      sector: r.sic_description || '',
      employees: r.total_employees || 0,
      listDate: r.list_date || '',
      shareClassSharesOutstanding: r.share_class_shares_outstanding || 0,
      weightedSharesOutstanding: r.weighted_shares_outstanding || 0,
      marketCap: r.market_cap || 0
    };
  } catch (e) {
    return null;
  }
}

// Get price history for learning/grading
async function getPriceAfterDate(ticker, fromDate, daysForward = 5) {
  try {
    const toDate = getDateDaysAhead(fromDate, daysForward + 2);
    const data = await polygonGet(`/v2/aggs/ticker/${ticker}/range/1/day/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=10`);
    const results = data.results || [];
    if (results.length === 0) return null;
    // Find highest close in the window
    const maxClose = Math.max(...results.map(r => r.c));
    const entryClose = results[0].c;
    return {
      entryClose,
      maxClose,
      maxMovePercent: ((maxClose - entryClose) / entryClose) * 100,
      dayByDay: results.map(r => ({ date: new Date(r.t).toISOString().split('T')[0], close: r.c }))
    };
  } catch (e) {
    return null;
  }
}

// ─── SEC EDGAR ────────────────────────────────────────────────────────────────

async function getRecentFilings(ticker) {
  try {
    // Search EDGAR for recent filings by ticker
    const res = await fetchUrl(`https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&forms=8-K,6-K,SC+13D,SC+13G&dateRange=custom&startdt=${getDateDaysAgo(3)}&enddt=${getTodayDate()}`);
    if (res.status !== 200) return [];
    const data = JSON.parse(res.body);
    const hits = data.hits?.hits || [];
    return hits.map(h => ({
      formType: h._source?.form_type || '',
      filedAt: h._source?.file_date || '',
      description: h._source?.file_description || h._source?.period_of_report || '',
      accession: h._source?.file_num || ''
    }));
  } catch (e) {
    return [];
  }
}

// ─── Learning System ──────────────────────────────────────────────────────────

async function buildLearningContext(data) {
  // Build a summary of what signals have worked and what haven't
  const gradedSignals = (data.signals || []).filter(s => s.graded && s.outcome);
  if (gradedSignals.length === 0) return 'No historical data yet — this is the first scan.';

  const winners = gradedSignals.filter(s => s.outcome.maxMovePercent >= 20);
  const losers = gradedSignals.filter(s => s.outcome.maxMovePercent < 20);

  // What signals appeared most in winners vs losers
  const signalWinCounts = {};
  const signalLossCounts = {};

  for (const s of winners) {
    for (const sig of (s.triggeredSignals || [])) {
      signalWinCounts[sig] = (signalWinCounts[sig] || 0) + 1;
    }
  }
  for (const s of losers) {
    for (const sig of (s.triggeredSignals || [])) {
      signalLossCounts[sig] = (signalLossCounts[sig] || 0) + 1;
    }
  }

  const recentLearning = (data.learningLog || []).slice(-10);

  return `
HISTORICAL PERFORMANCE (${gradedSignals.length} graded picks):
- Win rate (20%+ move): ${Math.round((winners.length / gradedSignals.length) * 100)}%
- Avg move on winners: ${winners.length ? (winners.reduce((a, s) => a + s.outcome.maxMovePercent, 0) / winners.length).toFixed(1) : 0}%
- Avg move on losers: ${losers.length ? (losers.reduce((a, s) => a + s.outcome.maxMovePercent, 0) / losers.length).toFixed(1) : 0}%

SIGNALS THAT PREDICTED WINS: ${JSON.stringify(signalWinCounts)}
SIGNALS THAT PREDICTED LOSSES: ${JSON.stringify(signalLossCounts)}

RECENT LESSONS LEARNED:
${recentLearning.map(l => `- ${l}`).join('\n') || 'None yet'}
  `.trim();
}

// ─── Core AI Analysis ─────────────────────────────────────────────────────────

async function analyzeAndPickStocks(candidates, learningContext) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  // Build candidate summaries for Claude
  const candidateSummaries = candidates.map((c, i) => `
[${i + 1}] TICKER: ${c.ticker}
Company: ${c.name}
Sector: ${c.sector || 'Unknown'}
Market Cap: $${(c.marketCap / 1e6).toFixed(1)}M
Price: $${c.price?.toFixed(2)}
Today's Change: ${c.todayChange?.toFixed(1)}%
Volume vs Avg: ${c.volumeRatio?.toFixed(1)}x
Float: ${c.float ? (c.float / 1e6).toFixed(1) + 'M shares' : 'Unknown'}
Recent Filings: ${c.filings?.map(f => f.formType + ' - ' + f.description).join('; ') || 'None'}
Recent News: ${c.news?.map(n => n.title).join('; ') || 'None'}
Price Momentum (5d): ${c.momentum5d?.toFixed(1)}%
Relative Volume: ${c.volumeRatio?.toFixed(1)}x average
  `.trim()).join('\n\n');

  const prompt = `You are an expert small-cap stock trader. Your job is to identify which stocks from the list below are most likely to make a 20%+ move within the next 1-3 trading days.

WHAT YOU KNOW FROM PAST PERFORMANCE:
${learningContext}

TODAY'S CANDIDATES (${candidates.length} stocks that passed initial filters):
${candidateSummaries}

YOUR TASK:
1. Analyze each candidate carefully
2. Only select stocks where you have GENUINE confidence in a 20%+ move — do not force picks if none qualify
3. Rank and return your TOP picks (maximum 3, minimum 0 if none qualify)
4. For each pick explain EXACTLY why it will move and what the catalyst is
5. Assign a confidence score 0-100

STRICT RULES:
- Do NOT pick a stock just to fill 3 slots
- Do NOT pick stocks with no clear catalyst
- Do NOT pick stocks that already made their big move today
- DO consider: volume spikes, fresh filings, news catalysts, compliance plays, low float + catalyst combinations
- DO factor in your historical performance data above

Respond with ONLY a JSON array (no markdown, no explanation outside the JSON):
[
  {
    "ticker": "XXXX",
    "companyName": "Full Company Name",
    "confidence": 85,
    "catalystSummary": "Plain English: exactly what is happening and why it will move",
    "keySignals": ["signal1", "signal2"],
    "entryNote": "When and how to buy",
    "targetMove": "Expected % move and timeframe",
    "riskNote": "Main risk that could make this wrong",
    "urgency": "BUY_BEFORE_OPEN or WATCH_OPEN or MONITOR"
  }
]

If zero stocks qualify, return an empty array: []`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = message.content[0]?.text || '[]';
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// After picks resolve — have Claude learn from the outcome
async function learnFromOutcome(pick, outcome, data) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  const prompt = `You are a trading AI reviewing your own past prediction.

YOUR PREDICTION:
- Ticker: ${pick.ticker}
- Catalyst you identified: ${pick.catalystSummary}
- Signals you used: ${pick.keySignals?.join(', ')}
- Confidence you assigned: ${pick.confidence}

ACTUAL OUTCOME:
- Max move within 5 days: ${outcome.maxMovePercent?.toFixed(1)}%
- Hit 20% target: ${outcome.maxMovePercent >= 20 ? 'YES' : 'NO'}
- Day by day: ${outcome.dayByDay?.map(d => d.date + ': $' + d.close?.toFixed(2)).join(', ')}

In one sentence, what is the single most important lesson to remember for future picks based on this outcome?
Be specific about what signal was right or wrong. No preamble, just the lesson.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 150,
    messages: [{ role: 'user', content: prompt }]
  });

  return message.content[0]?.text?.trim() || '';
}

// ─── Main Scanner ─────────────────────────────────────────────────────────────

async function runScan() {
  console.log(`\n[${new Date().toISOString()}] ═══ SCAN STARTING ═══`);
  const data = await loadData();

  try {
    // Step 1: Auto-grade any ungraded picks that are old enough (5+ days)
    await autoGradePastPicks(data);

    // Step 2: Get small cap universe
    console.log('Fetching small-cap universe...');
    const universe = await getSmallCapUniverse();
    if (universe.length === 0) {
      console.log('No universe data — aborting scan');
      return;
    }

    // Step 3: Initial filter pass — find stocks with unusual activity
    console.log(`Screening ${universe.length} stocks for unusual activity...`);
    const candidates = [];

    // Process in batches to avoid rate limiting
    const batchSize = 10;
    for (let i = 0; i < Math.min(universe.length, 200); i += batchSize) {
      const batch = universe.slice(i, i + batchSize);
      await Promise.all(batch.map(async (stock) => {
        try {
          const snap = await getTickerSnapshot(stock.ticker);
          if (!snap) return;
          if (snap.price < 1.0) return; // Robinhood minimum
          if (snap.price > 50) return;  // Focus on lower priced small caps

          const avgVol = await getAvgVolume(stock.ticker);
          const volumeRatio = avgVol > 0 ? snap.volume / avgVol : 0;

          // Pre-filter: must show SOME unusual activity to be worth analyzing
          const hasVolumeSpike = volumeRatio >= 1.5;
          const hasPriceMove = Math.abs(snap.todayChange) >= 3;
          const isNearDollar = snap.price < 2.5;

          if (!hasVolumeSpike && !hasPriceMove && !isNearDollar) return;

          // Get enrichment data for promising candidates
          const [details, news, filings] = await Promise.all([
            getTickerDetails(stock.ticker),
            getTickerNews(stock.ticker),
            getRecentFilings(stock.ticker)
          ]);

          const float = details?.weightedSharesOutstanding || details?.shareClassSharesOutstanding || 0;
          const momentum5d = await get5DayMomentum(stock.ticker);

          candidates.push({
            ticker: stock.ticker,
            name: stock.name || details?.name || stock.ticker,
            marketCap: stock.marketCap || details?.marketCap || 0,
            sector: details?.sector || '',
            price: snap.price,
            volume: snap.volume,
            avgVolume: avgVol,
            volumeRatio: Math.round(volumeRatio * 100) / 100,
            todayChange: snap.todayChange,
            momentum5d,
            float,
            news: news.slice(0, 3),
            filings: filings.slice(0, 3),
            triggeredSignals: [
              hasVolumeSpike ? 'volumeSpike' : null,
              hasPriceMove ? 'priceMove' : null,
              isNearDollar ? 'nearDollar' : null,
              filings.length > 0 ? 'recentFiling' : null,
              news.length > 0 ? 'recentNews' : null,
              float > 0 && float < 10_000_000 ? 'lowFloat' : null
            ].filter(Boolean)
          });

          console.log(`  Candidate: ${stock.ticker} — Vol ${volumeRatio.toFixed(1)}x — Change ${snap.todayChange?.toFixed(1)}%`);
        } catch (e) {
          // silently skip individual stock errors
        }
      }));

      // Small delay between batches
      await sleep(500);
    }

    console.log(`\nFound ${candidates.length} candidates after initial screen`);

    if (candidates.length === 0) {
      console.log('No candidates found — market may be quiet');
      await saveData(data);
      return;
    }

    // Step 4: AI picks the best 3
    console.log('Sending candidates to Claude for analysis...');
    const learningContext = await buildLearningContext(data);
    let picks = [];

    try {
      picks = await analyzeAndPickStocks(candidates, learningContext);
    } catch (e) {
      console.error('Claude analysis error:', e.message);
      return;
    }

    console.log(`Claude selected ${picks.length} picks`);

    if (picks.length === 0) {
      console.log('Claude found no qualifying picks today — no output generated');
      // Still save a scan record
      data.picks.push({
        id: `scan-${Date.now()}`,
        date: getTodayDate(),
        scannedAt: new Date().toISOString(),
        candidatesConsidered: candidates.length,
        picks: [],
        note: 'No qualifying picks found today'
      });
      await saveData(data);
      return;
    }

    // Step 5: Save picks with entry prices
    const pickSet = {
      id: `picks-${Date.now()}`,
      date: getTodayDate(),
      scannedAt: new Date().toISOString(),
      candidatesConsidered: candidates.length,
      picks: picks.map(p => ({
        ...p,
        entryPrice: candidates.find(c => c.ticker === p.ticker)?.price || 0,
        flaggedAt: new Date().toISOString(),
        graded: false,
        outcome: null
      }))
    };

    // Also save to signals log for learning
    for (const pick of pickSet.picks) {
      data.signals.push({
        ...pick,
        pickSetId: pickSet.id
      });
    }

    data.picks.unshift(pickSet);
    // Keep last 90 days of picks
    data.picks = data.picks.slice(0, 90);

    await saveData(data);
    console.log(`\n✓ Saved ${picks.length} picks for ${getTodayDate()}`);
    picks.forEach(p => console.log(`  → ${p.ticker} (${p.confidence}% confidence) — ${p.catalystSummary?.substring(0, 60)}...`));

  } catch (e) {
    console.error('Scan failed:', e.message);
  }
}

// ─── Auto Grading ─────────────────────────────────────────────────────────────

async function autoGradePastPicks(data) {
  const ungraded = (data.picks || [])
    .filter(ps => ps.picks?.some(p => !p.graded))
    .filter(ps => {
      const age = (Date.now() - new Date(ps.scannedAt).getTime()) / (1000 * 60 * 60 * 24);
      return age >= 5; // grade after 5 days
    });

  if (ungraded.length === 0) return;
  console.log(`Auto-grading ${ungraded.length} past pick sets...`);

  for (const pickSet of ungraded) {
    for (const pick of pickSet.picks) {
      if (pick.graded) continue;
      try {
        const outcome = await getPriceAfterDate(pick.ticker, pickSet.date, 5);
        if (!outcome) continue;

        pick.graded = true;
        pick.outcome = {
          ...outcome,
          hit20Percent: outcome.maxMovePercent >= 20,
          gradedAt: new Date().toISOString()
        };

        // Update matching signal
        const signal = (data.signals || []).find(s => s.ticker === pick.ticker && s.pickSetId === pickSet.id);
        if (signal) {
          signal.graded = true;
          signal.outcome = pick.outcome;
        }

        // Learn from outcome
        const lesson = await learnFromOutcome(pick, outcome, data);
        if (lesson) {
          data.learningLog = data.learningLog || [];
          data.learningLog.push(`[${pick.ticker} ${pickSet.date}] ${lesson}`);
          data.learningLog = data.learningLog.slice(-50); // keep last 50 lessons
          console.log(`  Lesson learned from ${pick.ticker}: ${lesson}`);
        }

        console.log(`  Graded ${pick.ticker}: max move ${outcome.maxMovePercent?.toFixed(1)}% — ${pick.outcome.hit20Percent ? '✓ WIN' : '✗ MISS'}`);
      } catch (e) {
        console.error(`  Grade error for ${pick.ticker}:`, e.message);
      }
    }
  }

  // Recalculate stats
  recalculateStats(data);
}

function recalculateStats(data) {
  const allPicks = (data.picks || []).flatMap(ps => ps.picks || []).filter(p => p.graded && p.outcome);
  if (allPicks.length === 0) return;

  const wins = allPicks.filter(p => p.outcome.hit20Percent);
  const totalMove = allPicks.reduce((a, p) => a + (p.outcome.maxMovePercent || 0), 0);

  const bySignal = {};
  for (const p of allPicks) {
    for (const sig of (p.keySignals || [])) {
      if (!bySignal[sig]) bySignal[sig] = { total: 0, wins: 0 };
      bySignal[sig].total++;
      if (p.outcome.hit20Percent) bySignal[sig].wins++;
    }
  }

  data.stats = {
    totalPicks: allPicks.length,
    correctPicks: wins.length,
    winRate: Math.round((wins.length / allPicks.length) * 100),
    avgMove: Math.round((totalMove / allPicks.length) * 10) / 10,
    bySignalType: bySignal,
    lastUpdated: new Date().toISOString()
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function get5DayMomentum(ticker) {
  try {
    const to = getPrevTradingDay();
    const from = getDateDaysAgo(8);
    const data = await polygonGet(`/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=5`);
    const results = data.results || [];
    if (results.length < 2) return 0;
    const first = results[0].c;
    const last = results[results.length - 1].c;
    return ((last - first) / first) * 100;
  } catch (e) {
    return 0;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

function getPrevTradingDay() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  if (d.getDay() === 0) d.setDate(d.getDate() - 2);
  if (d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function getDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

function getDateDaysAhead(fromDate, days) {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// ─── Scheduled Scans ──────────────────────────────────────────────────────────
// 9:00 PM EST — after market close
// 9:00 AM EST — 30 min before market open
// Weekdays only

cron.schedule('0 21 * * 1-5', () => {
  console.log('9:00 PM scan starting...');
  runScan().catch(console.error);
}, { timezone: 'America/New_York' });

cron.schedule('0 9 * * 1-5', () => {
  console.log('9:00 AM pre-market scan starting...');
  runScan().catch(console.error);
}, { timezone: 'America/New_York' });

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET today's picks
app.get('/api/picks/today', async (req, res) => {
  try {
    const data = await loadData();
    const today = getTodayDate();
    const todayPicks = data.picks?.find(ps => ps.date === today);
    res.json({ success: true, picks: todayPicks || null, stats: data.stats });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET all picks history
app.get('/api/picks', async (req, res) => {
  try {
    const data = await loadData();
    res.json({ success: true, picks: data.picks || [], stats: data.stats });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET stats
app.get('/api/stats', async (req, res) => {
  try {
    const data = await loadData();
    res.json({ success: true, stats: data.stats, learningLog: (data.learningLog || []).slice(-20) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST manual scan trigger
app.post('/api/scan', async (req, res) => {
  try {
    res.json({ success: true, message: 'Scan started' });
    runScan().catch(console.error);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET status
app.get('/api/status', async (req, res) => {
  try {
    const data = await loadData();
    const lastPick = data.picks?.[0];
    res.json({
      success: true,
      status: 'live',
      lastScan: lastPick?.scannedAt || null,
      totalPickSets: data.picks?.length || 0,
      stats: data.stats
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Health check
app.get('/', (req, res) => res.json({
  status: 'Catalyst Scanner v2 running',
  time: new Date().toISOString(),
  schedules: ['9:00 PM EST (weekdays)', '9:00 AM EST (weekdays)']
}));

app.listen(PORT, () => {
  console.log(`\nCatalyst Scanner v2 running on port ${PORT}`);
  console.log(`Scans: 9:00 PM + 9:00 AM EST weekdays`);
  console.log(`Polygon key: ${POLYGON_KEY ? '✓ configured' : '✗ MISSING'}`);
  console.log(`Anthropic key: ${ANTHROPIC_KEY ? '✓ configured' : '✗ MISSING'}`);
});
