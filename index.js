const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Firebase Admin ────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();
const messaging = admin.messaging();
console.log('[Firebase] Admin SDK initialized.');

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new NodeCache();
const TTL = {
  TICKER:   120,  // 2 dakika
  KLINES:    60,  // 1 dakika
  EXCHANGE: 300,  // 5 dakika
  VOLUME:   150,  // 2.5 dakika
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

// ── FCM Bildirim Gönder ───────────────────────────────────────────────────────
async function sendNotification(fcmToken, title, body, data = {}) {
  try {
    await messaging.send({
      token: fcmToken,
      notification: { title, body },
      data,
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    });
    console.log(`[FCM] Sent: ${title} → ${fcmToken.substring(0, 20)}...`);
    return true;
  } catch (err) {
    console.error('[FCM] Send error:', err.message);
    // Token geçersizse Firestore'dan sil
    if (
      err.code === 'messaging/invalid-registration-token' ||
      err.code === 'messaging/registration-token-not-registered'
    ) {
      await removeInvalidToken(fcmToken);
    }
    return false;
  }
}

// Geçersiz FCM token'ı tüm kullanıcılardan temizle
async function removeInvalidToken(fcmToken) {
  try {
    const snap = await db
      .collection('users')
      .where('fcmToken', '==', fcmToken)
      .get();
    for (const doc of snap.docs) {
      await doc.ref.update({ fcmToken: admin.firestore.FieldValue.delete() });
    }
    console.log('[FCM] Invalid token removed.');
  } catch (err) {
    console.error('[FCM] Token removal error:', err.message);
  }
}

// ── TP/SL Monitor ─────────────────────────────────────────────────────────────
// Daha önce bildirim gönderilmiş trade ID'lerini bellekte tut
// (Sunucu restart'ta sıfırlanır ama bu kabul edilebilir)
const _notifiedTrades = new Set();
let _monitorRunning = false;

async function runTradeMonitor() {
  if (_monitorRunning) return;

  // Rate limit cooldown aktifse atla
  if (Date.now() < _rateLimitUntil) {
    console.log('[Monitor] Rate limit cooldown active, skipping.');
    return;
  }

  _monitorRunning = true;

  try {
    // 1. Tüm açık trade'leri çek
    const tradesSnap = await db
      .collection('trades')
      .where('status', '==', 'open')
      .get();

    if (tradesSnap.empty) {
      _monitorRunning = false;
      return;
    }

    // 2. Benzersiz sembolleri topla
    const symbolSet = new Set();
    tradesSnap.docs.forEach(doc => symbolSet.add(doc.data().symbol));
    const symbols = Array.from(symbolSet);

    // 3. Binance'den anlık fiyatları çek (tek istek)
    const priceRes = await binance.get('/api/v3/ticker/price');
    const priceMap = {};
    priceRes.data.forEach(t => { priceMap[t.symbol] = parseFloat(t.price); });

    // 4. Her trade'i kontrol et
    for (const doc of tradesSnap.docs) {
      const trade = doc.data();
      const tradeId = doc.id;
      const currentPrice = priceMap[trade.symbol];

      if (!currentPrice) continue;

      const isLong = trade.type === 'long';
      const stopLoss = trade.stopLoss ? parseFloat(trade.stopLoss) : null;
      const takeProfit = trade.takeProfit ? parseFloat(trade.takeProfit) : null;

      // TP kontrolü
      if (takeProfit) {
        const tpKey = `tp_${tradeId}`;
        const tpHit = isLong
          ? currentPrice >= takeProfit
          : currentPrice <= takeProfit;

        if (tpHit && !_notifiedTrades.has(tpKey)) {
          _notifiedTrades.add(tpKey);

          // Kullanıcının FCM token'ını ve bildirim tercihini al
          const userDoc = await db.collection('users').doc(trade.userId).get();
          const fcmToken = userDoc.data()?.fcmToken;
          const notifPrefs = userDoc.data()?.notifications;

          // Kullanıcı trade alertleri kapattıysa gönderme
          if (fcmToken && notifPrefs?.tradeAlerts !== false) {
            const direction = isLong ? '📈 LONG' : '📉 SHORT';
            await sendNotification(
              fcmToken,
              '🎯 Take Profit Hit!',
              `${direction} ${trade.symbol} TP reached at $${currentPrice.toFixed(4)}`,
              { type: 'tp_hit', tradeId, symbol: trade.symbol }
            );
          }
        }
      }

      // SL kontrolü
      if (stopLoss) {
        const slKey = `sl_${tradeId}`;
        const slHit = isLong
          ? currentPrice <= stopLoss
          : currentPrice >= stopLoss;

        if (slHit && !_notifiedTrades.has(slKey)) {
          _notifiedTrades.add(slKey);

          // Kullanıcının FCM token'ını ve bildirim tercihini al
          const userDoc = await db.collection('users').doc(trade.userId).get();
          const fcmToken = userDoc.data()?.fcmToken;
          const notifPrefs = userDoc.data()?.notifications;

          // Kullanıcı trade alertleri kapattıysa gönderme
          if (fcmToken && notifPrefs?.tradeAlerts !== false) {
            const direction = isLong ? '📈 LONG' : '📉 SHORT';
            await sendNotification(
              fcmToken,
              '🛑 Stop Loss Hit',
              `${direction} ${trade.symbol} SL triggered at $${currentPrice.toFixed(4)}`,
              { type: 'sl_hit', tradeId, symbol: trade.symbol }
            );
          }
        }
      }
    }
  } catch (err) {
    if (err.response?.status === 418) {
      _rateLimitUntil = Date.now() + 10 * 60 * 1000;
      console.log('[Monitor] 418 rate limit — 10 min cooldown set.');
    } else {
      console.error('[Monitor] Error:', err.message);
    }
  }

  _monitorRunning = false;
}

// ── Sinyal Bildirimi ──────────────────────────────────────────────────────────
// Flutter tarafı yeni sinyal üretince bu endpoint'i çağırır
app.post('/api/notify/signal', async (req, res) => {
  try {
    const { symbol, type, strength, entryPrice } = req.body;

    if (!symbol || !type) {
      return res.status(400).json({ error: 'symbol and type required' });
    }

    // FCM token'ı olan tüm kullanıcılara bildirim gönder
    const usersSnap = await db
      .collection('users')
      .where('fcmToken', '!=', null)
      .get();

    const direction = type === 'long' ? '📈 LONG' : '📉 SHORT';
    const strengthStr = strength ? ` (${strength}% strength)` : '';

    let sent = 0;
    for (const doc of usersSnap.docs) {
      const fcmToken = doc.data().fcmToken;
      if (!fcmToken) continue;

      // Kullanıcı sinyal bildirimlerini kapattıysa gönderme
      const notifPrefs = doc.data()?.notifications;
      if (notifPrefs?.newSignals === false) continue;

      const ok = await sendNotification(
        fcmToken,
        `🎯 New Signal: ${symbol}`,
        `${direction} signal detected${strengthStr}`,
        { type: 'new_signal', symbol, signalType: type }
      );
      if (ok) sent++;
    }

    res.json({ success: true, notified: sent });
  } catch (err) {
    console.error('[Signal Notify] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Günlük Özet Bildirimi ────────────────────────────────────────────────────
// cron-job.org her sabah 09:00'da bu endpoint'i çağırır
app.get('/api/notify/daily-summary', async (req, res) => {
  try {
    const usersSnap = await db
      .collection('users')
      .where('fcmToken', '!=', null)
      .get();

    let sent = 0;
    for (const doc of usersSnap.docs) {
      const user = doc.data();
      const fcmToken = user.fcmToken;
      if (!fcmToken) continue;

      // Kullanıcı günlük özet bildirimini kapattıysa gönderme
      const notifPrefs = user.notifications;
      if (notifPrefs?.dailySummary === false) continue;

      const balance = (user.balance || 100).toFixed(2);
      const pnl = ((user.balance || 100) - 100).toFixed(2);
      const pnlSign = pnl >= 0 ? '+' : '';
      const totalTrades = user.totalTrades || 0;

      const ok = await sendNotification(
        fcmToken,
        '📊 Your Daily TradeX Summary',
        `Balance: $${balance} | PnL: ${pnlSign}$${pnl} | Trades: ${totalTrades}`,
        { type: 'daily_summary' }
      );
      if (ok) sent++;
    }

    res.json({ success: true, notified: sent });
  } catch (err) {
    console.error('[Daily Summary] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Trade Monitor Endpoint ────────────────────────────────────────────────────
// cron-job.org her 60 saniyede çağırır
app.get('/api/monitor/check', async (req, res) => {
  runTradeMonitor(); // fire-and-forget
  res.json({
    status: 'monitor_triggered',
    timestamp: new Date().toISOString(),
  });
});

// ── Volume Arka Plan Tarama ───────────────────────────────────────────────────
let _scanRunning = false;
let _rateLimitUntil = 0; // 418 rate limit sonrası cooldown

async function runVolumeBackgroundScan() {
  if (_scanRunning) {
    console.log('[Volume] Scan already running, skipping.');
    return;
  }

  // Rate limit cooldown aktifse atla
  const now = Date.now();
  if (now < _rateLimitUntil) {
    const waitSec = Math.ceil((_rateLimitUntil - now) / 1000);
    console.log(`[Volume] Rate limit cooldown — ${waitSec}s remaining, skipping.`);
    return;
  }

  _scanRunning = true;
  console.log('[Volume] Background scan started:', new Date().toISOString());

  const intervals = ['1m', '3m', '5m', '15m', '1h', '4h'];

  try {
    const tickerRes = await binance.get('/api/v3/ticker/24hr', { timeout: 15000 });
    const usdtPairs = tickerRes.data
      .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.quoteVolume) > 10000)
      .map(t => t.symbol);

    console.log(`[Volume] ${usdtPairs.length} USDT pairs found.`);

    for (const interval of intervals) {
      const cacheKey = `volume_top30_${interval}`;

      if (cache.get(cacheKey) !== undefined) {
        console.log(`[Volume] ${interval} — cache fresh, skipping.`);
        continue;
      }

      console.log(`[Volume] Scanning ${interval}...`);
      const results = [];
      const BATCH = 10; // rate limit koruması için azaltıldı

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

        // 418 kontrolü
        const hasRateLimit = batchResults.some(r =>
          r.status === 'rejected' && r.reason?.response?.status === 418
        );
        if (hasRateLimit) {
          _rateLimitUntil = Date.now() + 10 * 60 * 1000;
          console.log(`[Volume] 418 rate limit — 10 min cooldown, aborting.`);
          results.length = 0; // sonuçları temizle
          break;
        }

        await new Promise(res => setTimeout(res, 400)); // 50ms → 400ms
      }

      results.sort((a, b) => b.v3 - a.v3);
      const top30 = results.slice(0, 30);
      cache.set(cacheKey, top30, TTL.VOLUME);
      console.log(`[Volume] ${interval} — done, ${top30.length} coins cached.`);

      // Interval'lar arası 3 saniye bekle
      await new Promise(res => setTimeout(res, 3000));
    }
  } catch (err) {
    if (err.response?.status === 418) {
      _rateLimitUntil = Date.now() + 10 * 60 * 1000;
      console.log('[Volume] 418 rate limit (top-level) — 10 min cooldown set.');
    } else {
      console.error('[Volume] Background scan error:', err.message);
    }
  } finally {
    _scanRunning = false;
    console.log('[Volume] Background scan finished:', new Date().toISOString());
  }
}

// Sunucu başlayınca ilk taramayı hemen yap
runVolumeBackgroundScan();

// ── Routes ────────────────────────────────────────────────────────────────────

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

app.get('/api/volume/refresh', (req, res) => {
  const hadCache = ['1m','3m','5m','15m','1h','4h']
    .map(iv => cache.get(`volume_top30_${iv}`) !== undefined)
    .filter(Boolean).length;

  runVolumeBackgroundScan();

  res.json({
    status: 'scan_triggered',
    scanAlreadyRunning: _scanRunning,
    cachedIntervals: hadCache,
    timestamp: new Date().toISOString(),
  });
});

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

  console.log(`[Volume] Cache miss for ${safeInterval}, waiting for scan...`);

  if (!_scanRunning) runVolumeBackgroundScan();

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 500));
    const ready = cache.get(cacheKey);
    if (ready) {
      return res.json({ fromCache: false, data: ready });
    }
  }

  res.status(503).json({ error: 'Volume scan still in progress, please retry.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`TradeX backend running on port ${PORT}`);
});
