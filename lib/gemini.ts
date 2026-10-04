import { GoogleGenAI, type GenerateContentParameters } from "@google/genai";

const RETRYABLE = /\b(429|500|503)\b|UNAVAILABLE|RESOURCE_EXHAUSTED/;

/** generateContent with a few retries: Gemini returns transient 503s under load. */
export async function generateWithRetry(apiKey: string, params: GenerateContentParameters) {
  const ai = new GoogleGenAI({ apiKey });
  for (let attempt = 0; ; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 3 || !RETRYABLE.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
}
