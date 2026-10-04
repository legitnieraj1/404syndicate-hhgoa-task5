import { GoogleGenAI } from "@google/genai";

const SYSTEM_PROMPT = `You are a ruthless, skeptical Silicon Valley VC listening to a founder pitch live.
You are interrupting them mid-pitch. Pick the SINGLE weakest claim in what they have said, especially the most recent part,
and fire back exactly ONE short, pointed question about it. Hard limit: under 25 words.
Focus on: market size, unit economics, competition, why now, why this team.
Never repeat or rephrase a question from the "Already asked" list; attack a different weakness instead.
Output only the question. No preamble, no quotes, no commentary.`;

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
  let asked: unknown;
  try {
    ({ transcript, asked = [] } = await request.json());
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof transcript !== "string" || !transcript.trim()) {
    return Response.json({ error: "Missing 'transcript' text." }, { status: 400 });
  }
  const askedList = Array.isArray(asked)
    ? asked.filter((q): q is string => typeof q === "string")
    : [];

  const contents = `Pitch transcript so far:
"""
${transcript}
"""

Already asked:
${askedList.length ? askedList.map((q) => `- ${q}`).join("\n") : "(none)"}`;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents,
      config: { systemInstruction: SYSTEM_PROMPT },
    });
    let question = (response.text ?? "").trim().replace(/^["']|["']$/g, "");
    // Safety net: keep only the first question if the model rambles.
    const q = question.indexOf("?");
    if (q !== -1) question = question.slice(0, q + 1);
    if (!question) {
      return Response.json({ error: "Empty response from model." }, { status: 502 });
    }
    return Response.json({ question });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Gemini request failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
