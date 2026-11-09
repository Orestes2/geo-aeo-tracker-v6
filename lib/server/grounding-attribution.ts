/**
 * Atribución de grounding por URL, no por dominio.
 *
 * La API de grounding de Gemini devuelve cada chunk como
 *   { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZ...", title: "lalegalista.com" }
 * El `title` es solo el host y la URL real va detrás del redirect. Comparar por
 * host hace que cualquier página del dominio cuente como objetivo, incluida una
 * que no existe.
 *
 * Verificado el 2026-11-09 contra la versión anterior: pidiendo
 * /pagina-que-no-existe-xyz123/ devolvía targetUrlFound=true y selectionRate=100%.
 */

const REDIRECT_HOST = "vertexaisearch.cloud.google.com";
const RESOLVE_TIMEOUT_MS = 8000;
const redirectCache = new Map<string, string>();

export function normalizeUrl(input: string): string {
  try {
    const u = new URL(input);
    u.hash = "";
    u.search = "";
    u.protocol = "https:";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    let s = u.toString();
    if (!s.endsWith("/")) s += "/";
    return s;
  } catch {
    return input.trim().toLowerCase();
  }
}

export function hostOf(input: string): string {
  try {
    return new URL(input).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function resolveOne(uri: string): Promise<string> {
  const cached = redirectCache.get(uri);
  if (cached) return cached;
  if (!uri || !uri.includes(REDIRECT_HOST)) {
    if (uri) redirectCache.set(uri, uri);
    return uri;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const res = await fetch(uri, {
      method: "HEAD",
      redirect: "manual",
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; sro-tracker/1.0)" },
    });
    const loc = res.headers.get("location");
    const out = loc && /^https?:/i.test(loc) ? loc : uri;
    redirectCache.set(uri, out);
    return out;
  } catch {
    return uri; // fallo transitorio: no se cachea
  } finally {
    clearTimeout(timer);
  }
}

/** Resuelve los redirects en paralelo, con concurrencia acotada. */
export async function resolveChunkUrls(
  uris: string[],
  concurrency = 6,
): Promise<string[]> {
  const out: string[] = new Array(uris.length).fill("");
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= uris.length) return;
      out[i] = await resolveOne(uris[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, uris.length)) }, worker),
  );
  return out;
}

export interface UrlShare {
  url: string;
  host: string;
  words: number;
  share: number;
  chunkIndices: number[];
}

/**
 * Reparto del pool por URL. Un pasaje cuenta una vez por URL si cita al menos
 * un chunk de esa URL, igual que el cálculo original hacía con el objetivo, así
 * que las cuotas de distintas URL pueden sumar más de 1.
 */
export function buildUrlBreakdown(
  resolvedUrls: string[],
  supports: { text: string; chunkIndices: number[] }[],
  totalGroundingWords: number,
): UrlShare[] {
  const byUrl = new Map<string, { words: number; idx: Set<number> }>();
  resolvedUrls.forEach((u, i) => {
    const k = normalizeUrl(u);
    if (!byUrl.has(k)) byUrl.set(k, { words: 0, idx: new Set() });
    byUrl.get(k)!.idx.add(i);
  });
  for (const s of supports) {
    const w = s.text ? s.text.split(/\s+/).filter(Boolean).length : 0;
    const here = new Set(
      (s.chunkIndices ?? [])
        .filter((i) => i >= 0 && i < resolvedUrls.length)
        .map((i) => normalizeUrl(resolvedUrls[i])),
    );
    for (const u of here) {
      const e = byUrl.get(u);
      if (e) e.words += w;
    }
  }
  return [...byUrl.entries()]
    .map(([url, v]) => ({
      url,
      host: hostOf(url),
      words: v.words,
      share: totalGroundingWords > 0 ? v.words / totalGroundingWords : 0,
      chunkIndices: [...v.idx].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.words - a.words);
}
