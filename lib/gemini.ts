import {
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";

// Used when GEMINI_FALLBACK_MODELS isn't set. Text-capable models only
// (the *-tts models return audio, not text).
const DEFAULT_FALLBACKS = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];

const TRANSIENT = /\b(429|500|503)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand/i;

function modelChain(primary: string): string[] {
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return [...new Set([primary, ...(fallbacks.length ? fallbacks : DEFAULT_FALLBACKS)])];
}

/**
 * Tries GEMINI_MODEL first, then each fallback model in order. Each model gets a couple of
 * quick retries for transient errors. A model "fails" if it throws, or if `parse` rejects its
 * output (empty text, bad JSON, ...). Throws the last error if every model fails.
 */
export async function generateWithFallback<T>(
  apiKey: string,
  primaryModel: string,
  params: Omit<GenerateContentParameters, "model">,
  parse: (response: GenerateContentResponse) => T,
): Promise<T> {
  const ai = new GoogleGenAI({ apiKey });
  let lastError: unknown = new Error("No model configured.");

  for (const model of modelChain(primaryModel)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return parse(await ai.models.generateContent({ ...params, model }));
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!TRANSIENT.test(msg)) break; // not worth retrying; try the next model
        await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
      }
    }
    console.warn(`[gemini] model "${model}" failed, trying next fallback`);
  }
  throw lastError;
}
