import type {
  GroundingResult,
  GroundingChunk as AppGroundingChunk,
  GroundingSupport,
} from "./sro-types";
import { withTimeout } from "./http";
import {
  resolveChunkUrls,
  buildUrlBreakdown,
  normalizeUrl,
} from "./grounding-attribution";

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}


export async function analyzeGrounding(
  keyword: string,
  targetUrl: string,
): Promise<GroundingResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not set.");
  }

  // Dynamic import to avoid failing if the package isn't installed
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey });

  const response = await withTimeout(
    ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: keyword,
      config: {
        tools: [{ googleSearch: {} }],
      },
    }),
    45_000,
    "gemini grounding",
  );

  const candidate = response.candidates?.[0];
  const metadata = candidate?.groundingMetadata;
  const answerText = response.text ?? "";

  const rawChunks = metadata?.groundingChunks ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chunks: AppGroundingChunk[] = (rawChunks as any[]).map((c) => ({
    uri: c?.web?.uri ?? "",
    title: c?.web?.title ?? "",
  }));

  const rawSupports = metadata?.groundingSupports ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supports: GroundingSupport[] = (rawSupports as any[]).map((s) => ({
    startIndex: s?.segment?.startIndex ?? 0,
    endIndex: s?.segment?.endIndex ?? 0,
    text: s?.segment?.text ?? "",
    chunkIndices: s?.groundingChunkIndices ?? [],
    confidenceScores: s?.confidenceScores ?? [],
  }));

  const searchQueries = (metadata?.webSearchQueries as string[]) ?? [];

  const targetDomain = extractDomain(targetUrl);
  const targetChunkIndices: number[] = [];
  const resolvedUrls = await resolveChunkUrls(chunks.map((c) => c.uri));
  resolvedUrls.forEach((u, i) => {
    chunks[i].resolvedUrl = u;
    chunks[i].unresolved =
      u === chunks[i].uri && u.includes("vertexaisearch.cloud.google.com");
  });

  // Atribucion por URL completa, no por host: el title de Gemini es solo el
  // dominio, asi que comparar por host contaba cualquier pagina del sitio.
  const normTarget = normalizeUrl(targetUrl);
  resolvedUrls.forEach((u, idx) => {
    if (normalizeUrl(u) === normTarget) {
      targetChunkIndices.push(idx);
    }
  });

  const targetUrlFound = targetChunkIndices.length > 0;

  const targetSnippets: string[] = [];
  for (const support of supports) {
    const refsTarget = support.chunkIndices.some((idx) =>
      targetChunkIndices.includes(idx),
    );
    if (refsTarget && support.text) {
      targetSnippets.push(support.text);
    }
  }

  const totalGroundingWords = supports.reduce(
    (sum, s) => sum + (s.text?.split(/\s+/).length ?? 0),
    0,
  );
  const targetGroundingWords = targetSnippets.reduce(
    (sum, s) => sum + s.split(/\s+/).length,
    0,
  );

  const selectionRate =
    totalGroundingWords > 0 ? targetGroundingWords / totalGroundingWords : 0;

  const domainWords = supports.reduce((sum, s) => {
    const hit = (s.chunkIndices ?? []).some(
      (i) =>
        i >= 0 &&
        i < resolvedUrls.length &&
        extractDomain(resolvedUrls[i]) === targetDomain,
    );
    return hit ? sum + (s.text?.split(/\s+/).filter(Boolean).length ?? 0) : sum;
  }, 0);
  const domainSelectionRate =
    totalGroundingWords > 0 ? domainWords / totalGroundingWords : 0;

  return {
    query: keyword,
    answer: answerText,
    searchQueries,
    chunks,
    supports,
    targetUrlFound,
    targetUrlChunkIndices: targetChunkIndices,
    targetSnippets,
    totalGroundingWords,
    targetGroundingWords,
    selectionRate,
    urlBreakdown: buildUrlBreakdown(resolvedUrls, supports, totalGroundingWords),
    domainSelectionRate,
    unresolvedCount: chunks.filter((c) => c.unresolved).length,
  };
}
