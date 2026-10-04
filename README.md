# Pitch Roaster

Pitch your startup out loud. A ruthless dog-VC listens, interrupts you mid-sentence with one brutal question, and at the end hands you a scorecard.

> **Built entirely by voice** using [Wispr Flow](https://wisprflow.ai) and [Claude Code](https://claude.com/claude-code). I never typed the code.

## How it works

1. **Pick your VC** (each has its own personality and its own voice):
   - **The Shark** (Doberman): aggressive and impatient
   - **The Numbers Guy** (Poodle): only cares about metrics
   - **The Skeptic** (Bulldog): thinks every startup is just a feature
2. **Start pitching.** Your words appear live on screen (browser speech recognition).
3. **Get interrupted.** After about 2.5 seconds of silence, or every 30 seconds of non-stop talking, the full transcript goes to Gemini. The VC picks your weakest claim and fires back one question under 25 words. It is spoken aloud and slams onto the screen. Your mic pauses while the VC talks, then resumes so you can answer. The VC never repeats a question.
4. **End the pitch.** The transcript plus every question and answer goes to Gemini, which returns JSON with scores out of 100 for clarity, conviction, objection handling and market knowledge. It also returns your best answer, your worst answer, and a savage line on whether they invest.

## Tech

- Next.js (App Router) + Tailwind CSS
- Google's official `@google/genai` SDK, called only from server route handlers (`app/api/roast`, `app/api/score`), so your key never reaches the browser
- Web Speech API for recognition and speech synthesis (no extra services)

## Setup

You need Node.js 20+ and a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

```bash
npm install
cp .env.example .env
```

Open `.env` and fill it in:

```bash
GEMINI_API_KEY=your-api-key
GEMINI_MODEL=gemini-3.8-flash
# Optional: comma-separated backups, tried in order if GEMINI_MODEL fails
GEMINI_FALLBACK_MODELS=gemini-3.5-flash,gemini-3.1-flash-lite
```

`GEMINI_MODEL` must be a model **ID** (lowercase, hyphens), not a display name like "Gemini 3.8 Flash". `.env` is git-ignored.

## Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in **Chrome, Edge or Safari** and allow microphone access when asked.

## Model fallback

If the primary model errors or returns something unusable (empty text, invalid JSON), the app tries each model in `GEMINI_FALLBACK_MODELS` in turn. Temporary overload errors (429/503) get a couple of quick retries on each model first. If you leave the variable unset, it falls back to `gemini-3.5-flash`, then `gemini-3.1-flash-lite`.

Use text models only. The `*-tts` models (such as `gemini-3.8-flash-lite-tts`) return audio instead of text, so they can't write questions or scorecards.

## Troubleshooting

| Message | Fix |
| --- | --- |
| "Speech recognition isn't supported" | Use Chrome, Edge or Safari on desktop. Firefox has no speech recognition. |
| "Your microphone is blocked" | Click the lock icon in the address bar, set Microphone to Allow, reload. |
| "No microphone found" | Plug in or select a microphone in your system settings. |
| "Speech recognition needs a secure page" | Use `http://localhost` or `https://`. |
| "unexpected model name format" | `GEMINI_MODEL` must be an ID like `gemini-3.8-flash`. |
