"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Scorecard from "./scorecard";
import { VC_LIST, VCS, type LogEntry, type Scorecard as ScorecardData, type Vc, type VcId } from "@/lib/vcs";

const SILENCE_MS = 2500;
const MAX_TALK_MS = 30000;

// Web Speech API isn't in the default TS DOM lib.
type SpeechResultEvent = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

const subscribeNoop = () => () => {};

const MIC_MESSAGES: Record<string, string> = {
  "not-allowed":
    "Your microphone is blocked. Click the lock icon in the address bar, set Microphone to Allow, then reload the page.",
  "service-not-allowed":
    "This browser won't let the page use speech recognition. Check your microphone permission and browser settings, then reload.",
  "audio-capture":
    "No microphone found. Plug one in (or pick one in your system settings) and try again.",
  network:
    "The speech recognition service is unreachable. Check your internet connection and try again.",
  "language-not-supported": "Speech recognition doesn't support this language in your browser.",
};

function fmtTime(total: number) {
  const m = Math.floor(total / 60);
  return `${String(m).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

type Phase = "idle" | "listening" | "thinking" | "speaking";

function pickVoice(vc: Vc): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  for (const name of vc.voice.prefer) {
    const hit = voices.find((v) => v.name.includes(name));
    if (hit) return hit;
  }
  // Fallback: a stable, different voice per persona.
  const idx = VC_LIST.findIndex((x) => x.id === vc.id);
  return voices.length ? voices[idx % voices.length] : undefined;
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Press Start and pitch.",
  listening: "Listening…",
  thinking: "VC is thinking…",
  speaking: "VC is speaking…",
};

export default function Home() {
  const supported = useSyncExternalStore(
    subscribeNoop,
    () => !!getRecognitionCtor(),
    () => true,
  );
  const canSpeak = useSyncExternalStore(
    subscribeNoop,
    () => "speechSynthesis" in window,
    () => true,
  );
  const startedAtRef = useRef(0);
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [finalText, setFinalText] = useState("");
  const [interim, setInterim] = useState("");
  const [answerText, setAnswerText] = useState("");
  const [question, setQuestion] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState("");
  const [micProblem, setMicProblem] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [vcId, setVcId] = useState<VcId | null>(null);
  const [scoring, setScoring] = useState(false);
  const [card, setCard] = useState<ScorecardData | null>(null);

  // Mutable session state lives in refs so recognition callbacks never see stale values.
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const runningRef = useRef(false);
  const activeRef = useRef(false);
  const phaseRef = useRef<Phase>("idle");
  const sessionRef = useRef(0);
  const transcriptRef = useRef("");
  const interimRef = useRef("");
  const answerRef = useRef("");
  const askedRef = useRef<string[]>([]);
  const sentLenRef = useRef(0);
  const lastTriggerRef = useRef(0);
  const pendingQRef = useRef<string | null>(null);
  const vcRef = useRef<VcId>("shark");
  const logRef = useRef<LogEntry[]>([]);
  const endWaitRef = useRef<(() => void) | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function setPhase(p: Phase) {
    phaseRef.current = p;
    setPhaseState(p);
  }

  function clearSilenceTimer() {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;
  }

  function startRecognition() {
    if (runningRef.current || !activeRef.current) return;
    try {
      recRef.current?.start();
      runningRef.current = true;
    } catch {
      /* already started */
    }
  }

  // Attach the current answer buffer to the latest log entry.
  function commitAnswer() {
    const answer = answerRef.current.trim();
    answerRef.current = "";
    setAnswerText("");
    const last = logRef.current[logRef.current.length - 1];
    if (!answer || !last) return;
    last.answer = (last.answer + " " + answer).trim();
    setLog(logRef.current.map((e) => ({ ...e })));
  }

  // Recognition is stopped by now: log the question, speak it, then resume listening.
  function deliverQuestion(q: string) {
    pendingQRef.current = null;
    commitAnswer();
    askedRef.current.push(q);
    logRef.current.push({ question: q, answer: "" });
    setLog(logRef.current.map((e) => ({ ...e })));
    setQuestion(q);
    setPhase("speaking");

    const resume = () => {
      if (!activeRef.current) return;
      lastTriggerRef.current = Date.now();
      setPhase("listening");
      startRecognition();
    };
    const synth = window.speechSynthesis;
    if (!synth) return resume();
    synth.cancel();
    const vc = VCS[vcRef.current];
    const utter = new SpeechSynthesisUtterance(q);
    const voice = pickVoice(vc);
    if (voice) utter.voice = voice;
    utter.pitch = vc.voice.pitch;
    utter.rate = vc.voice.rate;
    utter.onend = resume;
    utter.onerror = resume;
    synth.speak(utter);
  }

  async function interrupt() {
    if (phaseRef.current !== "listening" || !activeRef.current) return;
    const transcript = (transcriptRef.current + " " + interimRef.current).trim();
    // Nothing new since the last interruption.
    if (transcript.length <= sentLenRef.current) return;
    sentLenRef.current = transcript.length;
    lastTriggerRef.current = Date.now();
    clearSilenceTimer();
    setPhase("thinking");
    const session = sessionRef.current;

    try {
      const res = await fetch("/api/roast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript, asked: askedRef.current, vc: vcRef.current }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      if (session !== sessionRef.current || !activeRef.current) return;

      // Pause transcription while the VC talks; onend delivers the question.
      pendingQRef.current = data.question;
      setPhase("speaking");
      if (runningRef.current) recRef.current?.stop();
      else deliverQuestion(data.question);
    } catch (err) {
      if (session !== sessionRef.current || !activeRef.current) return;
      setError(err instanceof Error ? err.message : "Request failed");
      lastTriggerRef.current = Date.now();
      setPhase("listening");
    }
  }

  useEffect(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
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
      if (finals) {
        transcriptRef.current = (transcriptRef.current + " " + finals).trim();
        answerRef.current = (answerRef.current + " " + finals).trim();
        setFinalText(transcriptRef.current);
        setAnswerText(answerRef.current);
      }
      interimRef.current = partial;
      setInterim(partial);

      if (phaseRef.current !== "listening" || !(finals || partial)) return;
      // Pause of ~2.5s ends the pitch burst; 30s of non-stop talking forces one.
      clearSilenceTimer();
      silenceTimerRef.current = setTimeout(interrupt, SILENCE_MS);
      if (Date.now() - lastTriggerRef.current >= MAX_TALK_MS) interrupt();
    };

    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      const known = MIC_MESSAGES[e.error ?? ""];
      if (!known) {
        setError(`Speech recognition error: ${e.error ?? "unknown"}`);
        return;
      }
      setMicProblem(known);
      // Every known mic/service error is fatal; restarting would just loop.
      sessionRef.current++;
      activeRef.current = false;
      clearSilenceTimer();
      window.speechSynthesis?.cancel();
      setPhase("idle");
    };

    rec.onend = () => {
      runningRef.current = false;
      interimRef.current = "";
      setInterim("");
      if (!activeRef.current) {
        commitAnswer();
        endWaitRef.current?.();
        return;
      }
      if (phaseRef.current === "speaking" && pendingQRef.current) {
        deliverQuestion(pendingQRef.current);
      } else if (phaseRef.current !== "speaking") {
        startRecognition(); // Chrome ends sessions on its own; keep going.
      }
    };

    recRef.current = rec;
    return () => {
      activeRef.current = false;
      clearSilenceTimer();
      window.speechSynthesis?.cancel();
      rec.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    setMicProblem("");
    if (!window.isSecureContext) {
      setMicProblem(
        "Speech recognition needs a secure page. Open the app on https:// or http://localhost.",
      );
      return;
    }
    try {
      const perm = await navigator.permissions?.query({ name: "microphone" as PermissionName });
      if (perm?.state === "denied") {
        setMicProblem(MIC_MESSAGES["not-allowed"]);
        return;
      }
    } catch {
      /* Permissions API unavailable for microphone (e.g. Safari); recognition will ask. */
    }
    startedAtRef.current = Date.now();
    setElapsed(0);
    sessionRef.current++;
    transcriptRef.current = "";
    interimRef.current = "";
    answerRef.current = "";
    askedRef.current = [];
    logRef.current = [];
    sentLenRef.current = 0;
    pendingQRef.current = null;
    lastTriggerRef.current = Date.now();
    setFinalText("");
    setInterim("");
    setAnswerText("");
    setQuestion("");
    setLog([]);
    setError("");
    activeRef.current = true;
    setPhase("listening");
    startRecognition();
  }

  // Used for fatal mic errors: stop everything without scoring.
  function stop() {
    sessionRef.current++;
    activeRef.current = false;
    pendingQRef.current = null;
    clearSilenceTimer();
    window.speechSynthesis?.cancel();
    setPhase("idle");
    if (runningRef.current) recRef.current?.stop();
    else commitAnswer();
  }

  async function endPitch() {
    if (!transcriptRef.current.trim() && !interimRef.current.trim()) {
      stop();
      setError("Say something first, then end the pitch.");
      return;
    }
    stop();
    setScoring(true);
    setError("");
    // Let recognition flush its last words into the transcript and answer log.
    if (runningRef.current) {
      await new Promise<void>((resolve) => {
        endWaitRef.current = resolve;
        setTimeout(resolve, 1500);
      });
      endWaitRef.current = null;
    }
    commitAnswer();
    try {
      const res = await fetch("/api/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: transcriptRef.current,
          log: logRef.current,
          vc: vcRef.current,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setCard(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setScoring(false);
    }
  }

  function chooseVc(id: VcId) {
    vcRef.current = id;
    setVcId(id);
    // Voices load lazily in some browsers; touch the list so they're ready.
    window.speechSynthesis?.getVoices();
  }

  function restart() {
    setCard(null);
    setError("");
    setFinalText("");
    setQuestion("");
    setLog([]);
    setMicProblem("");
    setElapsed(0);
    setVcId(null);
  }

  const active = phase !== "idle";

  useEffect(() => {
    if (!active) return;
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)),
      500,
    );
    return () => clearInterval(id);
  }, [active]);

  const liveAnswer = (answerText + " " + interim).trim();

  if (card && vcId) return <Scorecard card={card} vc={VCS[vcId]} onRestart={restart} />;

  const vc = vcId ? VCS[vcId] : null;
  const listening = phase === "listening";

  const notices = (
    <>
      {!supported && (
        <div role="alert" className="rounded-xl border-2 border-red-600 bg-red-950/60 p-4 text-red-200">
          <p className="font-bold">🚫 Speech recognition isn&apos;t supported in this browser.</p>
          <p className="mt-1 text-sm">
            The VCs can&apos;t hear you here. Open Pitch Roaster in Google Chrome, Microsoft Edge or
            Safari on desktop.
          </p>
        </div>
      )}
      {micProblem && (
        <div role="alert" className="rounded-xl border-2 border-red-600 bg-red-950/60 p-4 text-red-200">
          <p className="font-bold">🎙️ Microphone problem</p>
          <p className="mt-1 text-sm">{micProblem}</p>
        </div>
      )}
      {!canSpeak && (
        <div className="rounded-xl border border-amber-500/60 bg-amber-950/40 p-4 text-sm text-amber-200">
          This browser can&apos;t speak out loud, so the VC&apos;s questions will only appear on screen.
        </div>
      )}
    </>
  );

  if (!vc) {
    return (
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-14">
        <header className="text-center">
          <p className="text-xs font-bold uppercase tracking-[0.5em] text-brass">
            🐾 Doghouse &amp; Partners · Boardroom
          </p>
          <h1 className="mt-3 text-5xl font-black tracking-tight sm:text-6xl">Pitch Roaster</h1>
          <p className="mt-3 text-stone-400">Take a seat. Choose the dog who decides your fate.</p>
        </header>
        {notices}
        <div className="grid gap-5 sm:grid-cols-3">
          {VC_LIST.map((v) => (
            <button
              key={v.id}
              onClick={() => chooseVc(v.id)}
              className="group flex flex-col items-center gap-3 rounded-2xl border-2 border-brass/40 bg-black/40 p-6 text-center shadow-[0_0_30px_rgba(0,0,0,0.6)] transition hover:-translate-y-1 hover:border-red-600 hover:bg-red-950/30"
            >
              <span className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-brass bg-stone-900 text-6xl transition group-hover:scale-110">
                {v.emoji}
              </span>
              <span className="text-xl font-extrabold">{v.name}</span>
              <span className="text-sm text-stone-400">{v.tagline}</span>
            </button>
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-10">
      {scoring && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/90 text-white">
          <span className="text-7xl">{vc.emoji}</span>
          <p className="animate-pulse text-3xl font-black uppercase tracking-widest text-red-500">
            {vc.name} is deliberating…
          </p>
          <p className="text-stone-400">Tallying the damage.</p>
        </div>
      )}

      <header className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.4em] text-brass">
            🐾 Doghouse &amp; Partners
          </p>
          <h1 className="text-3xl font-black tracking-tight">Pitch Roaster</h1>
        </div>
        <div
          className="flex items-center gap-2 rounded-lg border border-brass/50 bg-black/60 px-4 py-2 font-mono text-2xl tabular-nums"
          aria-label="Pitch timer"
        >
          <span className={`h-3 w-3 rounded-full ${active ? "animate-pulse bg-red-600" : "bg-stone-600"}`} />
          {fmtTime(elapsed)}
        </div>
      </header>

      {notices}

      <section className="flex flex-col items-center gap-4 rounded-3xl border-2 border-brass/30 bg-black/40 p-6 text-center">
        <div
          className={`flex h-28 w-28 items-center justify-center rounded-full border-4 bg-stone-900 text-7xl ${
            phase === "speaking" ? "animate-pulse border-red-600" : "border-brass"
          }`}
        >
          {vc.emoji}
        </div>
        <div>
          <p className="text-xl font-extrabold">{vc.name}</p>
          <p className="text-sm text-stone-400">{vc.tagline}</p>
          {!active && (
            <button
              onClick={() => setVcId(null)}
              className="mt-1 text-sm text-stone-400 underline hover:text-red-500"
            >
              Change VC
            </button>
          )}
        </div>

        <div className="relative flex h-24 w-24 items-center justify-center">
          {listening && (
            <>
              <span className="absolute inset-0 animate-ping rounded-full bg-red-600/50" />
              <span className="absolute -inset-3 animate-ping rounded-full bg-red-600/20 [animation-delay:400ms]" />
            </>
          )}
          <span
            className={`relative flex h-20 w-20 items-center justify-center rounded-full ${
              listening ? "bg-red-600 shadow-[0_0_30px_rgba(220,38,38,0.9)]" : "bg-stone-800"
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-9 w-9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          </span>
        </div>
        <p className="text-sm font-semibold uppercase tracking-widest text-stone-300">
          {PHASE_LABEL[phase]}
        </p>

        {!active ? (
          <button
            onClick={start}
            disabled={!supported || scoring}
            className="rounded-full bg-red-600 px-10 py-3 text-lg font-extrabold uppercase tracking-wider text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Start pitch
          </button>
        ) : (
          <button
            onClick={endPitch}
            className="rounded-full border-2 border-brass px-10 py-3 text-lg font-extrabold uppercase tracking-wider text-brass transition hover:bg-brass hover:text-black"
          >
            End pitch
          </button>
        )}
      </section>

      {question && (
        <section key={log.length} role="alert" className="slam relative">
          <div className="flash pointer-events-none fixed inset-0 z-40 bg-red-600/40" />
          <div className="rounded-2xl border-4 border-red-600 bg-red-950/80 p-6 shadow-[0_0_60px_rgba(220,38,38,0.6)]">
            <p className="text-sm font-black uppercase tracking-[0.3em] text-red-500">
              🦴 Interruption #{log.length}
            </p>
            <p className="mt-2 text-3xl font-black leading-tight text-red-100 sm:text-4xl">{question}</p>
          </div>
        </section>
      )}

      <section
        aria-live="polite"
        className="min-h-36 whitespace-pre-wrap rounded-xl border border-brass/30 bg-black/40 p-5 text-lg"
      >
        {finalText || interim ? (
          <>
            {finalText}
            {interim && <span className="text-stone-500"> {interim}</span>}
          </>
        ) : (
          <span className="text-stone-500">Your pitch will appear here.</span>
        )}
      </section>

      {error && <p className="text-red-400">Error: {error}</p>}

      {log.length > 0 && (
        <section>
          <h2 className="mb-3 text-xl font-bold text-brass">Q&amp;A log</h2>
          <ol className="flex flex-col gap-4">
            {log.map((entry, i) => {
              const isLast = i === log.length - 1;
              const answer = isLast ? (entry.answer + " " + liveAnswer).trim() : entry.answer;
              return (
                <li key={i} className="rounded-xl border border-brass/30 bg-black/40 p-4">
                  <p className="font-semibold text-red-400">
                    Q{i + 1}: {entry.question}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap">
                    <span className="font-semibold text-brass">You: </span>
                    {answer || <span className="text-stone-500">(no answer yet)</span>}
                  </p>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </main>
  );
}
