// Barre de recherche : suggestions de saisie relayées par le serveur (évite les blocages CORS du navigateur).
import { getJson } from './http.js';

// moteurs et adresse de recherche ({q} = texte saisi)
export const ENGINES = {
  DuckDuckGo: 'https://duckduckgo.com/?q={q}',
  Google: 'https://www.google.com/search?q={q}',
  Bing: 'https://www.bing.com/search?q={q}',
  Qwant: 'https://www.qwant.com/?q={q}',
  Ecosia: 'https://www.ecosia.org/search?q={q}',
  Brave: 'https://search.brave.com/search?q={q}',
  Startpage: 'https://www.startpage.com/do/search?q={q}'
};

// sources de suggestions : le moteur choisi s'il en a, sinon DuckDuckGo
const SUGGEST = {
  DuckDuckGo: q => `https://duckduckgo.com/ac/?type=list&kl=fr-fr&q=${q}`,
  Google: q => `https://suggestqueries.google.com/complete/search?client=firefox&hl=fr&q=${q}`,
  Brave: q => `https://search.brave.com/api/suggest?q=${q}`
};

export async function suggest(engine, searxUrl, query) {
  const q = encodeURIComponent(String(query || '').slice(0, 200));
  if (!q) return [];
  let url;
  if (engine === 'SearXNG' && /^https?:\/\//i.test(searxUrl || '')) url = `${searxUrl.replace(/\/+$/, '')}/autocompleter?q=${q}`;
  else url = (SUGGEST[engine] || SUGGEST.DuckDuckGo)(q);
  const r = await getJson(url, { timeout: 4000, insecure: engine === 'SearXNG' });
  // format OpenSearch : [requête, [suggestions…]]
  const list = Array.isArray(r) ? (Array.isArray(r[1]) ? r[1] : r) : [];
  return list.map(x => (typeof x === 'string' ? x : x?.phrase || '')).filter(Boolean).slice(0, 8);
}
