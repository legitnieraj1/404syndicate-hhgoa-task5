"use client";

import { useEffect, useRef, useState } from "react";

// Web Speech API isn't in the default TS DOM lib.
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

export default function Home() {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [finalText, setFinalText] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");
  const [roast, setRoast] = useState("");
  const [loading, setLoading] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    const Ctor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) {
      setSupported(false);
      return;
    }
    const rec: SpeechRecognitionLike = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      let finals = "";
      let partial = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finals += r[0].transcript;
        else partial += r[0].transcript;
      }
      if (finals) setFinalText((t) => (t + " " + finals).trim());
      setInterim(partial);
    };
    rec.onerror = (e) => setError(e.error ?? "Speech recognition error");
    rec.onend = () => {
      setListening(false);
      setInterim("");
    };
    recRef.current = rec;
    return () => rec.stop();
  }, []);

  function start() {
    setError("");
    setRoast("");
    setFinalText("");
    try {
      recRef.current?.start();
      setListening(true);
    } catch {
      /* already started */
    }
  }

  function stop() {
    recRef.current?.stop();
  }

  async function roastMe() {
    setLoading(true);
    setError("");
    setRoast("");
    try {
      const res = await fetch("/api/roast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pitch: finalText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setRoast(data.roast);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  const transcript = (finalText + " " + interim).trim();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <header>
        <h1 className="text-4xl font-bold tracking-tight">Pitch Roaster 🔥</h1>
        <p className="mt-2 text-neutral-500">
          Pitch your startup out loud. The AI VC will roast you.
        </p>
      </header>

      {!supported && (
        <p className="rounded-lg bg-red-500/10 p-4 text-red-500">
          Speech recognition isn&apos;t supported in this browser. Try Chrome or Safari.
        </p>
      )}

      <div className="flex gap-3">
        {!listening ? (
          <button
            onClick={start}
            disabled={!supported}
            className="rounded-full bg-orange-500 px-6 py-3 font-semibold text-white transition hover:bg-orange-600 disabled:opacity-40"
          >
            Start
          </button>
        ) : (
          <button
            onClick={stop}
            className="rounded-full bg-neutral-800 px-6 py-3 font-semibold text-white transition hover:bg-neutral-700"
          >
            Stop
          </button>
        )}
        <button
          onClick={roastMe}
          disabled={listening || loading || !finalText}
          className="rounded-full border border-orange-500 px-6 py-3 font-semibold text-orange-500 transition hover:bg-orange-500/10 disabled:opacity-40"
        >
          {loading ? "Roasting…" : "Roast me"}
        </button>
      </div>

      <section
        aria-live="polite"
        className="min-h-40 whitespace-pre-wrap rounded-xl border border-neutral-500/30 p-5 text-lg"
      >
        {transcript ? (
          <>
            {finalText}
            {interim && <span className="text-neutral-500"> {interim}</span>}
          </>
        ) : (
          <span className="text-neutral-500">
            {listening ? "Listening…" : "Your pitch will appear here."}
          </span>
        )}
      </section>

      {error && <p className="text-red-500">Error: {error}</p>}

      {roast && (
        <section className="whitespace-pre-wrap rounded-xl bg-orange-500/10 p-5">
          <h2 className="mb-2 font-semibold text-orange-500">The VC says:</h2>
          {roast}
        </section>
      )}
    </main>
  );
}
