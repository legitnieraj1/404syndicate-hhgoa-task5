import { Type } from "@google/genai";
import { generateWithFallback } from "@/lib/gemini";
import { getVc, type LogEntry, type Scorecard } from "@/lib/vcs";

const BASE_PROMPT = `You have just finished listening to a founder's pitch, including your interruptions and their answers.
Judge it honestly and harshly. Score each dimension as an integer from 0 to 100:
- clarity: how clear and easy to follow the pitch was
- conviction: how confident and compelling the founder sounded
- objectionHandling: how well they answered your questions
- marketKnowledge: how well they know their market, customers and competitors
Pick their best answer and their worst answer to your questions. For each, "quote" is a short verbatim excerpt
(under 30 words) of what they said, and "why" is one sharp sentence explaining the judgment.
If they gave no real answers, say so in the quote field and score accordingly.
Finish with a verdict: "invest" (true only if genuinely impressed) and "line", ONE savage, quotable sentence
in your character's voice on whether you invest. Return JSON only.`;

const quoteSchema = {
  type: Type.OBJECT,
  properties: { quote: { type: Type.STRING }, why: { type: Type.STRING } },
  required: ["quote", "why"],
};

const schema = {
  type: Type.OBJECT,
  properties: {
    clarity: { type: Type.INTEGER },
    conviction: { type: Type.INTEGER },
    objectionHandling: { type: Type.INTEGER },
    marketKnowledge: { type: Type.INTEGER },
    bestAnswer: quoteSchema,
    worstAnswer: quoteSchema,
    verdict: {
      type: Type.OBJECT,
      properties: { invest: { type: Type.BOOLEAN }, line: { type: Type.STRING } },
      required: ["invest", "line"],
    },
  },
  required: [
    "clarity",
    "conviction",
    "objectionHandling",
    "marketKnowledge",
    "bestAnswer",
    "worstAnswer",
    "verdict",
  ],
};

const clamp = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL;
  if (!apiKey || !model) {
    return Response.json(
      { error: "GEMINI_API_KEY and GEMINI_MODEL must be set in the environment." },
      { status: 500 },
    );
  }

  let transcript: unknown;
  let log: unknown;
  let vcId: unknown;
  try {
    ({ transcript, log = [], vc: vcId } = await request.json());
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof transcript !== "string" || !transcript.trim()) {
    return Response.json({ error: "Missing 'transcript' text." }, { status: 400 });
  }
  const entries: LogEntry[] = Array.isArray(log)
    ? log.filter(
        (e): e is LogEntry =>
          !!e && typeof e.question === "string" && typeof e.answer === "string",
      )
    : [];

  const contents = `Full pitch transcript:
"""
${transcript}
"""

Questions asked and the founder's answers:
${
  entries.length
    ? entries
        .map((e, i) => `Q${i + 1}: ${e.question}\nA${i + 1}: ${e.answer || "(no answer)"}`)
        .join("\n\n")
    : "(no questions were asked)"
}`;

  try {
    const card = await generateWithFallback(
      apiKey,
      model,
      {
        contents,
        config: {
          systemInstruction: `${getVc(vcId).persona}\n\n${BASE_PROMPT}`,
          responseMimeType: "application/json",
          responseSchema: schema,
        },
      },
      (response): Scorecard => {
        const raw = JSON.parse(response.text ?? "");
        return {
          clarity: clamp(raw.clarity),
          conviction: clamp(raw.conviction),
          objectionHandling: clamp(raw.objectionHandling),
          marketKnowledge: clamp(raw.marketKnowledge),
          bestAnswer: {
            quote: String(raw.bestAnswer?.quote ?? ""),
            why: String(raw.bestAnswer?.why ?? ""),
          },
          worstAnswer: {
            quote: String(raw.worstAnswer?.quote ?? ""),
            why: String(raw.worstAnswer?.why ?? ""),
          },
          verdict: { invest: !!raw.verdict?.invest, line: String(raw.verdict?.line ?? "") },
        };
      },
    );
    return Response.json(card);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Gemini request failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
