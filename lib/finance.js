// Cours de bourse, matières premières et cryptomonnaies via l'API publique de graphiques
// de Yahoo Finance (gratuite, sans clé). Symboles au format Yahoo : AAPL, MC.PA, ^FCHI,
// GC=F (or), BTC-EUR, ETH-EUR, EURUSD=X…
import { getJson } from './http.js';

const HOSTS = (process.env.YF_HOSTS || 'https://query1.finance.yahoo.com,https://query2.finance.yahoo.com').split(',');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

// période affichée → [range Yahoo, intervalle des points]
export const RANGES = {
  '1 jour': ['1d', '5m'], '5 jours': ['5d', '30m'], '1 mois': ['1mo', '1d'], '3 mois': ['3mo', '1d'],
  '6 mois': ['6mo', '1d'], '1 an': ['1y', '1d'], '5 ans': ['5y', '1wk'], 'Max': ['max', '1mo']
};

const cache = new Map(); // clé → { at, data }
async function yahoo(path, ttl = 60e3) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  let lastErr;
  for (const h of HOSTS) {
    try {
      const data = await getJson(h + path, { timeout: 10000, headers: { 'User-Agent': UA } });
      cache.set(path, { at: Date.now(), data });
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      return data;
    } catch (e) {
      if (/^HTTP 404/.test(e.message)) throw Object.assign(new Error('introuvable'), { notFound: true });
      lastErr = e;
    }
  }
  // service indisponible ou limite de requêtes atteinte : dernier résultat connu (moins de 6 h)
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.data;
  throw /HTTP 429/.test(lastErr?.message) ? new Error('Yahoo Finance limite les requêtes pour le moment, réessaie dans quelques minutes') : lastErr;
}

const cleanSymbol = s => {
  const v = String(s || '').trim().toUpperCase();
  if (!/^[A-Z0-9^=.\-]{1,20}$/.test(v)) throw new Error('Symbole invalide (exemples : AAPL, MC.PA, ^FCHI, GC=F, BTC-EUR)');
  return v;
};

async function chart(symbol, range, interval, ttl) {
  let d;
  try { d = await yahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`, ttl); }
  catch (e) { if (e.notFound) throw new Error(`Symbole « ${symbol} » introuvable : utilise « Rechercher » dans les réglages du widget`); throw e; }
  const r = d?.chart?.result?.[0];
  if (!r) throw new Error(d?.chart?.error?.description || `Symbole « ${symbol} » introuvable`);
  return r;
}

export async function quote({ symbol = 'BTC-EUR', range = '1 mois' } = {}) {
  const sym = cleanSymbol(symbol);
  const [yr, iv] = RANGES[range] || RANGES['1 mois'];
  const r = await chart(sym, yr, iv, yr === '1d' || yr === '5d' ? 60e3 : 300e3);
  const m = r.meta || {};
  const closes = r.indicators?.quote?.[0]?.close || [];
  const points = (r.timestamp || []).map((t, i) => [t * 1000, closes[i]]).filter(p => typeof p[1] === 'number');
  const price = typeof m.regularMarketPrice === 'number' ? m.regularMarketPrice : points.at(-1)?.[1];
  if (price == null) throw new Error(`Aucune donnée pour « ${sym} »`);

  // variation du jour : clôture de la veille
  let prev = yr === '1d' ? (m.chartPreviousClose ?? m.previousClose) : m.previousClose;
  if (prev == null) {
    try {
      const day = await chart(sym, '5d', '1d', 60e3);
      const c = (day.indicators?.quote?.[0]?.close || []).filter(v => typeof v === 'number');
      if (c.length >= 2) prev = c[c.length - 2];
    } catch { /* variation du jour indisponible */ }
  }
  // base de la période : clôture précédant le premier point (ou premier point)
  const base = yr === '1d' ? prev : (m.chartPreviousClose ?? points[0]?.[1]);
  const reg = m.currentTradingPeriod?.regular;
  const crypto = m.instrumentType === 'CRYPTOCURRENCY';
  const now = Date.now() / 1000;
  return {
    symbol: m.symbol || sym,
    name: m.longName || m.shortName || sym,
    currency: m.currency || '',
    exchange: m.fullExchangeName || m.exchangeName || '',
    type: m.instrumentType || '',
    price,
    prev: prev ?? null,
    dayChange: prev != null ? price - prev : null,
    dayPct: prev ? (price - prev) / prev * 100 : null,
    base: base ?? null,
    rangeChange: base != null ? price - base : null,
    rangePct: base ? (price - base) / base * 100 : null,
    range: RANGES[range] ? range : '1 mois',
    open: crypto || (reg ? now >= reg.start && now < reg.end : null),
    time: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
    points
  };
}

// recherche de symbole (formulaire du widget)
export async function searchSymbol(q) {
  const s = String(q || '').trim();
  if (!s) return [];
  const d = await yahoo(`/v1/finance/search?q=${encodeURIComponent(s)}&quotesCount=10&newsCount=0&listsCount=0&lang=fr-FR&region=FR`, 3600e3);
  return (d.quotes || []).filter(x => x.symbol).map(x => ({
    symbol: x.symbol, name: x.longname || x.shortname || x.symbol,
    type: x.typeDisp || x.quoteType || '', exchange: x.exchDisp || x.exchange || ''
  }));
}
