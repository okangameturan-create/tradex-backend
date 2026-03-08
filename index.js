const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new NodeCache();
const TTL = {
  TICKER:   120,  // 2 dakika
  KLINES:    60,  // 1 dakika
  EXCHANGE: 300,  // 5 dakika
  VOLUME:   150,  // 2.5 dakika — arka plan tarama aralığından biraz uzun
};

// ── Binance client ────────────────────────────────────────────────────────────
const binance = axios.create({
  baseURL: 'https://api.binance.com',
  timeout: 15000,
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use(globalLimiter);

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

// ── Arka plan volume tarama fonksiyonu ────────────────────────────────────────
// HTTP isteğinden bağımsız çalışır — Render 30s timeout'u etkilemez.
// Her interval için ayrı cache key → kullanıcı hangi interval'i seçmişse
// o zaten hazır olur.
let _scanRunning = false;

async function runVolumeBackgroundScan() {
  if (_scanRunning) {
    console.log('[Volume] Scan already running, skipping.');
    return;
  }
  _scanRunning = true;
  console.log('[Volume] Background scan started:', new Date().toISOString());

  const intervals = ['1m', '3m', '5m', '15m', '1h', '4h'];

  try {
    // Adım 1: Ticker — hacimli USDT coinlerini bul
    const tickerRes = await binance.get('/api/v3/ticker/24hr', { timeout: 15000 });
    const usdtPairs = tickerRes.data
      .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.quoteVolume) > 10000)
      .map(t => t.symbol);

    console.log(`[Volume] ${usdtPairs.length} USDT pairs found.`);

    // Her interval için tarama yap
    for (const interval of intervals) {
      const cacheKey = `volume_top30_${interval}`;

      // Cache hâlâ tazeyse atla
      if (cache.get(cacheKey) !== undefined) {
        console.log(`[Volume] ${interval} — cache fresh, skipping.`);
        continue;
      }

      console.log(`[Volume] Scanning ${interval}...`);
      const results = [];
      const BATCH = 20;

      for (let i = 0; i < usdtPairs.length; i += BATCH) {
        const batch = usdtPairs.slice(i, i + BATCH);

        const batchResults = await Promise.allSettled(
          batch.map(async (symbol) => {
            const cKey = `klines_${symbol}_${interval}_4`;
            let klines;

            const cachedKlines = cache.get(cKey);
            if (cachedKlines) {
              klines = cachedKlines;
            } else {
              const r = await binance.get('/api/v3/klines', {
                params: { symbol, interval, limit: 4 },
                timeout: 10000,
              });
              klines = r.data;
              cache.set(cKey, klines, TTL.KLINES);
            }

            if (!klines || klines.length < 3) return null;

            const v1 = parseFloat(klines[0][7]) || 0;
            const v2 = parseFloat(klines[1][7]) || 0;
            const v3 = parseFloat(klines[2][7]) || 0;
            const price = parseFloat(klines[klines.length - 1][4]) || 0;
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
              quoteVolume: v3,
            };
          })
        );

        for (const r of batchResults) {
          if (r.status === 'fulfilled' && r.value) {
            results.push(r.value);
          }
        }

        // Batch'ler arası küçük bekleme — Binance rate limit koruması
        await new Promise(res => setTimeout(res, 50));
      }

      results.sort((a, b) => b.v3 - a.v3);
      const top30 = results.slice(0, 30);
      cache.set(cacheKey, top30, TTL.VOLUME);
      console.log(`[Volume] ${interval} — done, ${top30.length} coins cached.`);
    }
  } catch (err) {
    console.error('[Volume] Background scan error:', err.message);
  } finally {
    _scanRunning = false;
    console.log('[Volume] Background scan finished:', new Date().toISOString());
  }
}

// ── Sunucu başlayınca ilk taramayı hemen yap ─────────────────────────────────
runVolumeBackgroundScan();

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  const intervals = ['1m', '3m', '5m', '15m', '1h', '4h'];
  const cacheStatus = {};
  for (const iv of intervals) {
    cacheStatus[iv] = cache.get(`volume_top30_${iv}`) !== undefined ? 'ready' : 'empty';
  }

  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    cacheKeys: cache.keys().length,
    volumeCache: cacheStatus,
    scanRunning: _scanRunning,
    timestamp: new Date().toISOString(),
  });
});

// Volume refresh — cron-job.org bu endpoint'i ping'ler
// Hem servisi uyandırır hem taramayı tetikler
app.get('/api/volume/refresh', (req, res) => {
  const hadCache = ['1m','3m','5m','15m','1h','4h']
    .map(iv => cache.get(`volume_top30_${iv}`) !== undefined)
    .filter(Boolean).length;

  // Fire-and-forget — HTTP cevabını bekletmez
  runVolumeBackgroundScan();

  res.json({
    status: 'scan_triggered',
    scanAlreadyRunning: _scanRunning,
    cachedIntervals: hadCache,
    timestamp: new Date().toISOString(),
  });
});

// ── 1. Tüm USDT ticker'ları ──────────────────────────────────────────────────
app.get('/api/ticker', async (req, res) => {
  try {
    const result = await cachedGet('ticker_24hr', TTL.TICKER, async () => {
      const r = await binance.get('/api/v3/ticker/24hr');
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
app.get('/api/klines', async (req, res) => {
  const { symbol, interval, limit } = req.query;

  if (!symbol || !interval) {
    return res.status(400).json({ error: 'symbol and interval are required.' });
  }

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

// ── 3. Sembol listesi ────────────────────────────────────────────────────────
app.get('/api/symbols', async (req, res) => {
  try {
    const result = await cachedGet('exchange_symbols', TTL.EXCHANGE, async () => {
      const r = await binance.get('/api/v3/exchangeInfo');
      return r.data.symbols
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

// ── 4. Volume scan — cache'den anında döner ──────────────────────────────────
// Arka plan görevi her 2 dakikada cache'i doldurur.
// Kullanıcı bu endpoint'e bastığında bekleme olmaz.
app.get('/api/volume', async (req, res) => {
  const { interval } = req.query;
  const safeInterval = ['1m','3m','5m','15m','1h','4h'].includes(interval)
    ? interval
    : '1h';

  const cacheKey = `volume_top30_${safeInterval}`;
  const cached = cache.get(cacheKey);

  if (cached) {
    return res.json({ fromCache: true, data: cached });
  }

  // Cache henüz dolmamış (ilk açılış) — tek seferlik bekle
  console.log(`[Volume] Cache miss for ${safeInterval}, waiting for scan...`);

  // Tarama çalışmıyorsa başlat
  if (!_scanRunning) runVolumeBackgroundScan();

  // Max 25 saniye bekle — 500ms'de bir kontrol et
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 500));
    const ready = cache.get(cacheKey);
    if (ready) {
      return res.json({ fromCache: false, data: ready });
    }
  }

  // 25 saniyede gelmezse hata döndür
  res.status(503).json({ error: 'Volume scan still in progress, please retry.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`TradeX backend running on port ${PORT}`);
});
