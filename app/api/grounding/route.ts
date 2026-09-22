import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { analyzeGrounding } from "@/lib/server/gemini-grounding";

export const runtime = "nodejs";
// Google Search grounding can take a while; the lib already caps at 45s.
export const maxDuration = 60;

const bodySchema = z.object({
  targetUrl: z.string().url(),
  keyword: z.string().min(1).max(500),
});

/**
 * GET /api/grounding
 *   -> reports whether GEMINI_API_KEY is visible to this deployment.
 *
 * GET /api/grounding?test=1
 *   -> performs a real, minimal grounded call so you can confirm the key
 *      works AND that Google Search grounding is actually enabled for it.
 *      Returns the underlying Gemini error verbatim when it fails.
 */
export async function GET(req: NextRequest) {
  const configured = Boolean(process.env.GEMINI_API_KEY);
  const runTest = req.nextUrl.searchParams.get("test") === "1";

  if (!configured) {
    return NextResponse.json(
      {
        ok: false,
        configured: false,
        code: "MISSING_KEY",
        error:
          "GEMINI_API_KEY is not set for this deployment. Add it in Vercel -> Settings -> Environment Variables and redeploy.",
      },
      { status: 503 },
    );
  }

  if (!runTest) {
    return NextResponse.json({ ok: true, configured: true });
  }

  try {
    const result = await analyzeGrounding(
      "What is generative engine optimization?",
      "https://example.com",
    );
    return NextResponse.json({
      ok: true,
      configured: true,
      groundingActive: result.chunks.length > 0,
      searchQueries: result.searchQueries,
      chunkCount: result.chunks.length,
      sampleSources: result.chunks.slice(0, 5).map((c) => c.title),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[grounding] self-test failed:", message);
    return NextResponse.json(
      { ok: false, configured: true, code: "GEMINI_ERROR", error: message },
      { status: 502 },
    );
  }
}

/**
 * POST /api/grounding  { targetUrl, keyword }
 * Runs the Gemini Google-Search grounding stage of the SRO pipeline.
 *
 * Unlike /api/bulk-sro - which swallows grounding failures silently - this
 * route surfaces the real error so a misconfigured key is visible instead of
 * showing up as a permanently empty grounding panel.
 */
export async function POST(req: NextRequest) {
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", error: message },
      { status: 400 },
    );
  }

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      {
        ok: false,
        code: "MISSING_KEY",
        error:
          "GEMINI_API_KEY is not set for this deployment. Add it in Vercel -> Settings -> Environment Variables and redeploy.",
      },
      { status: 503 },
    );
  }

  try {
    const grounding = await analyzeGrounding(parsed.keyword, parsed.targetUrl);
    return NextResponse.json({ ok: true, grounding });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[grounding] Gemini grounding failed:", message);
    return NextResponse.json(
      { ok: false, code: "GEMINI_ERROR", error: message },
      { status: 502 },
    );
  }
}
