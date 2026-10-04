import { GoogleGenAI } from "@google/genai";

const SYSTEM_PROMPT = `You are a ruthless, sharp-tongued venture capitalist listening to a startup pitch.
Roast the pitch with wit, then ask 3 to 5 hard, specific questions a skeptical VC would ask
(market size, moat, unit economics, traction, why now, why you). Be funny but substantive.
Keep it under 200 words.`;

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL;
  if (!apiKey || !model) {
    return Response.json(
      { error: "GEMINI_API_KEY and GEMINI_MODEL must be set in the environment." },
      { status: 500 },
    );
  }

  let pitch: unknown;
  try {
    ({ pitch } = await request.json());
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof pitch !== "string" || !pitch.trim()) {
    return Response.json({ error: "Missing 'pitch' text." }, { status: 400 });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: pitch,
      config: { systemInstruction: SYSTEM_PROMPT },
    });
    return Response.json({ roast: response.text ?? "" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Gemini request failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
