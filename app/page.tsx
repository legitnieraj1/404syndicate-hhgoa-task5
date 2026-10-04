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
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [finalText, setFinalText] = useState("");
  const [interim, setInterim] = useState("");
  const [answerText, setAnswerText] = useState("");
  const [question, setQuestion] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState("");
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
      setError(e.error ?? "Speech recognition error");
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        sessionRef.current++;
        activeRef.current = false;
        clearSilenceTimer();
        window.speechSynthesis?.cancel();
        setPhase("idle");
      }
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

  function start() {
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
    setVcId(null);
  }

  const active = phase !== "idle";
  const liveAnswer = (answerText + " " + interim).trim();

  if (card && vcId) return <Scorecard card={card} vc={VCS[vcId]} onRestart={restart} />;

  if (!vcId) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-16">
        <header>
          <h1 className="text-4xl font-bold tracking-tight">Pitch Roaster 🔥</h1>
          <p className="mt-2 text-neutral-500">Pick the VC you have to survive.</p>
        </header>
        {!supported && (
          <p className="rounded-lg bg-red-500/10 p-4 text-red-500">
            Speech recognition isn&apos;t supported in this browser. Try Chrome or Safari.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          {VC_LIST.map((vc) => (
            <button
              key={vc.id}
              onClick={() => chooseVc(vc.id)}
              className="flex flex-col items-start gap-2 rounded-2xl border-2 border-neutral-500/30 p-5 text-left transition hover:border-red-600 hover:bg-red-600/5"
            >
              <span className="text-5xl">{vc.emoji}</span>
              <span className="text-xl font-bold">{vc.name}</span>
              <span className="text-neutral-500">{vc.tagline}</span>
            </button>
          ))}
        </div>
      </main>
    );
  }

  const vc = VCS[vcId];

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      {scoring && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/90 text-white">
          <p className="animate-pulse text-3xl font-black uppercase tracking-widest text-red-500">
            {vc.emoji} {vc.name} is deliberating…
          </p>
          <p className="text-neutral-400">Tallying the damage.</p>
        </div>
      )}
      <header>
        <h1 className="text-4xl font-bold tracking-tight">Pitch Roaster 🔥</h1>
        <p className="mt-2 text-neutral-500">
          Pitching to {vc.emoji} <strong>{vc.name}</strong>. {vc.tagline}
          {!active && (
            <button
              onClick={() => setVcId(null)}
              className="ml-2 text-sm underline hover:text-red-600"
            >
              Change VC
            </button>
          )}
        </p>
      </header>

      {!supported && (
        <p className="rounded-lg bg-red-500/10 p-4 text-red-500">
          Speech recognition isn&apos;t supported in this browser. Try Chrome or Safari.
        </p>
      )}

      <div className="flex items-center gap-4">
        {!active ? (
          <button
            onClick={start}
            disabled={!supported || scoring}
            className="rounded-full bg-orange-500 px-6 py-3 font-semibold text-white transition hover:bg-orange-600 disabled:opacity-40"
          >
            Start
          </button>
        ) : (
          <button
            onClick={endPitch}
            className="rounded-full bg-red-600 px-6 py-3 font-semibold text-white transition hover:bg-red-700"
          >
            End pitch
          </button>
        )}
        <span className="text-neutral-500">{PHASE_LABEL[phase]}</span>
      </div>

      {question && (
        <section
          role="alert"
          className={`rounded-2xl border-4 border-red-600 bg-red-600/10 p-6 ${
            phase === "speaking" ? "animate-pulse" : ""
          }`}
        >
          <p className="text-sm font-bold uppercase tracking-widest text-red-600">
            ⚠ Interruption
          </p>
          <p className="mt-2 text-3xl font-extrabold leading-tight text-red-600">{question}</p>
        </section>
      )}

      <section
        aria-live="polite"
        className="min-h-40 whitespace-pre-wrap rounded-xl border border-neutral-500/30 p-5 text-lg"
      >
        {finalText || interim ? (
          <>
            {finalText}
            {interim && <span className="text-neutral-500"> {interim}</span>}
          </>
        ) : (
          <span className="text-neutral-500">Your pitch will appear here.</span>
        )}
      </section>

      {error && <p className="text-red-500">Error: {error}</p>}

      {log.length > 0 && (
        <section>
          <h2 className="mb-3 text-xl font-semibold">Q&amp;A log</h2>
          <ol className="flex flex-col gap-4">
            {log.map((entry, i) => {
              const isLast = i === log.length - 1;
              const answer = isLast ? (entry.answer + " " + liveAnswer).trim() : entry.answer;
              return (
                <li key={i} className="rounded-xl border border-neutral-500/30 p-4">
                  <p className="font-semibold text-red-600">
                    Q{i + 1}: {entry.question}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap">
                    <span className="font-semibold">You: </span>
                    {answer || <span className="text-neutral-500">(no answer yet)</span>}
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
