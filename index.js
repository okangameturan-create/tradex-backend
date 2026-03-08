const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Cache ─────────────────────────────────────────────────────────────────────
// TTL saniye cinsinden
const cache = new NodeCache();
const TTL = {
  TICKER:  120,  // 2 dakika  — tüm USDT tickerları
  KLINES:   60,  // 1 dakika  — mum verileri
  EXCHANGE: 300, // 5 dakika  — exchangeInfo (sembol listesi)
};

// ── Binance client ────────────────────────────────────────────────────────────
const binance = axios.create({
  baseURL: 'https://api.binance.com',
  timeout: 15000,
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Global rate limit — IP başına dakikada max 120 istek
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use(globalLimiter);

// Volume endpoint için daha sıkı limit — pahalı işlem
const volumeLimiter = rateLimit({
  windowMs: 2 * 60 * 1000, // 2 dakika
  max: 3,                   // 2 dakikada max 3 istek
  message: { error: 'Volume scan rate limit exceeded. Please wait.' },
});

// ── Helper ────────────────────────────────────────────────────────────────────
async function cachedGet(cacheKey, ttl, fetchFn) {
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return { data: cached, fromCache: true };
  }
  const data = await fetchFn();
  cache.set(cacheKey, data, ttl);
  return { data, fromCache: false };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check — Render ve cron-job.org ping için
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    cacheKeys: cache.keys().length,
    timestamp: new Date().toISOString(),
  });
});

// ── 1. Tüm USDT ticker'ları ──────────────────────────────────────────────────
// Volume scan'in ilk adımı — hangi coinlerin hacmi var?
app.get('/api/ticker', async (req, res) => {
  try {
    const result = await cachedGet('ticker_24hr', TTL.TICKER, async () => {
      const r = await binance.get('/api/v3/ticker/24hr');
      // Sadece USDT çiftleri, gereksiz alanları at — payload küçültsün
      return r.data
        .filter(t => t.symbol.endsWith('USDT'))
        .map(t => ({
          symbol: t.symbol,
          quoteVolume: t.quoteVolume,
          lastPrice: t.lastPrice,
          priceChangePercent: t.priceChangePercent,
        }));
    });

    res.json({ fromCache: result.fromCache, data: result.data });
  } catch (err) {
    console.error('Ticker error:', err.message);
    res.status(502).json({ error: 'Failed to fetch ticker data from Binance.' });
  }
});

// ── 2. Kline (mum) verisi ────────────────────────────────────────────────────
// Volume scan ve sinyal analizi için
app.get('/api/klines', async (req, res) => {
  const { symbol, interval, limit } = req.query;

  if (!symbol || !interval) {
    return res.status(400).json({ error: 'symbol and interval are required.' });
  }

  // Güvenlik: sadece izinli interval değerleri
  const allowedIntervals = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','12h','1d'];
  if (!allowedIntervals.includes(interval)) {
    return res.status(400).json({ error: 'Invalid interval.' });
  }

  const safeLimit = Math.min(parseInt(limit) || 4, 500);
  const cacheKey = `klines_${symbol}_${interval}_${safeLimit}`;

  try {
    const result = await cachedGet(cacheKey, TTL.KLINES, async () => {
      const r = await binance.get('/api/v3/klines', {
        params: { symbol, interval, limit: safeLimit },
      });
      return r.data;
    });

    res.json({ fromCache: result.fromCache, data: result.data });
  } catch (err) {
    console.error(`Klines error [${symbol}]:`, err.message);
    res.status(502).json({ error: `Failed to fetch klines for ${symbol}.` });
  }
});

// ── 3. Sembol listesi (exchangeInfo) ─────────────────────────────────────────
// Signal scan başlangıcı için USDT çiftleri
app.get('/api/symbols', async (req, res) => {
  try {
    const result = await cachedGet('exchange_symbols', TTL.EXCHANGE, async () => {
      const r = await binance.get('/api/v3/exchangeInfo');
      return (r.data.symbols)
        .filter(s =>
          s.status === 'TRADING' &&
          s.quoteAsset === 'USDT' &&
          s.isSpotTradingAllowed === true
        )
        .map(s => s.symbol);
    });

    res.json({ fromCache: result.fromCache, data: result.data });
  } catch (err) {
    console.error('Symbols error:', err.message);
    res.status(502).json({ error: 'Failed to fetch symbols from Binance.' });
  }
});

// ── 4. Volume scan — en pahalı endpoint ─────────────────────────────────────
// Tüm tarama backend'de yapılır, Flutter'a sadece top 30 gelir
// volumeLimiter burada — sık sık çağrılmasın
app.get('/api/volume', volumeLimiter, async (req, res) => {
  const { interval } = req.query;
  const safeInterval = ['1m','3m','5m','15m','1h','4h','1d'].includes(interval)
    ? interval
    : '1h';

  const cacheKey = `volume_top30_${safeInterval}`;

  // Cache'de varsa hemen dön — Binance'a istek atmadan
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json({ fromCache: true, data: cached });
  }

  try {
    // Adım 1: Ticker — hangi coinler aktif ve hacimli?
    const tickerResult = await cachedGet('ticker_24hr', TTL.TICKER, async () => {
      const r = await binance.get('/api/v3/ticker/24hr');
      return r.data
        .filter(t => t.symbol.endsWith('USDT'))
        .map(t => ({
          symbol: t.symbol,
          quoteVolume: t.quoteVolume,
          lastPrice: t.lastPrice,
        }));
    });

    const usdtPairs = tickerResult.data
      .filter(t => parseFloat(t.quoteVolume) > 10000)
      .map(t => t.symbol);

    // Adım 2: Her coin için son periyot kline — paralel batch'ler
    const results = [];
    const BATCH = 20; // Backend'de daha büyük batch — rate limit riski yok

    for (let i = 0; i < usdtPairs.length; i += BATCH) {
      const batch = usdtPairs.slice(i, i + BATCH);

      const batchResults = await Promise.allSettled(
        batch.map(async (symbol) => {
          const cKey = `klines_${symbol}_${safeInterval}_4`;
          let klines;

          const cachedKlines = cache.get(cKey);
          if (cachedKlines) {
            klines = cachedKlines;
          } else {
            const r = await binance.get('/api/v3/klines', {
              params: { symbol, interval: safeInterval, limit: 4 },
              timeout: 8000,
            });
            klines = r.data;
            cache.set(cKey, klines, TTL.KLINES);
          }

          if (klines.length < 3) return null;

          const v1 = parseFloat(klines[0][7]) || 0;
          const v2 = parseFloat(klines[1][7]) || 0;
          const v3 = parseFloat(klines[2][7]) || 0;
          const price = parseFloat(klines[2][4]) || 0;
          const change1 = v1 > 0 ? (v2 - v1) / v1 * 100 : 0;
          const change2 = v2 > 0 ? (v3 - v2) / v2 * 100 : 0;

          return {
            symbol,
            baseAsset: symbol.replace('USDT', ''),
            price,
            v1, v2, v3,
            change1,
            change2,
            avgChange: (change1 + change2) / 2,
          };
        })
      );

      for (const r of batchResults) {
        if (r.status === 'fulfilled' && r.value) {
          results.push(r.value);
        }
      }
    }

    // Adım 3: V3'e göre sırala → top 30
    results.sort((a, b) => b.v3 - a.v3);
    const top30 = results.slice(0, 30);

    cache.set(cacheKey, top30, TTL.TICKER); // 2 dakika cache
    res.json({ fromCache: false, data: top30 });

  } catch (err) {
    console.error('Volume scan error:', err.message);
    res.status(502).json({ error: 'Volume scan failed.' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`TradeX backend running on port ${PORT}`);
});
