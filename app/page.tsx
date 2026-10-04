"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Bone,
  CaretRight,
  Dog,
  Microphone,
  MicrophoneSlash,
  PawPrint,
  Stop,
  Warning,
} from "@phosphor-icons/react";
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
  idle: "Ready when you are.",
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
    <div className="flex flex-col gap-3 empty:hidden">
      {!supported && (
        <div role="alert" className="flex gap-3 rounded-xl border border-accent/60 bg-accent/10 p-4">
          <MicrophoneSlash size={24} weight="bold" className="mt-0.5 shrink-0 text-accent" />
          <div>
            <p className="font-semibold">This browser can&apos;t do speech recognition.</p>
            <p className="mt-1 text-sm text-muted">
              The VCs can&apos;t hear you here. Open Pitch Roaster in Chrome, Edge or Safari on
              desktop.
            </p>
          </div>
        </div>
      )}
      {micProblem && (
        <div role="alert" className="flex gap-3 rounded-xl border border-accent/60 bg-accent/10 p-4">
          <MicrophoneSlash size={24} weight="bold" className="mt-0.5 shrink-0 text-accent" />
          <div>
            <p className="font-semibold">Microphone problem</p>
            <p className="mt-1 text-sm text-muted">{micProblem}</p>
          </div>
        </div>
      )}
      {!canSpeak && (
        <div className="flex gap-3 rounded-xl border border-line bg-surface p-4">
          <Warning size={24} weight="bold" className="mt-0.5 shrink-0 text-muted" />
          <p className="text-sm text-muted">
            This browser can&apos;t speak out loud, so the VC&apos;s questions will only appear on
            screen.
          </p>
        </div>
      )}
    </div>
  );

  if (!vc) {
    return (
      <main className="mx-auto grid w-full max-w-6xl flex-1 content-center gap-12 px-5 py-14 sm:px-8 lg:grid-cols-[5fr_7fr] lg:gap-16">
        <div className="flex flex-col justify-center gap-6">
          <div className="flex items-center gap-2 text-sm font-semibold text-muted">
            <PawPrint size={20} weight="fill" className="text-accent" />
            Pitch Roaster
          </div>
          <h1 className="text-5xl font-black leading-[0.95] tracking-tighter sm:text-6xl lg:text-7xl">
            Pick who you have to survive.
          </h1>
          <p className="max-w-[40ch] text-muted">
            Pitch out loud. One of three dogs interrupts you and scores the result.
          </p>
          {notices}
        </div>

        <ul className="flex flex-col divide-y divide-line self-center rounded-xl border border-line bg-surface/60">
          {VC_LIST.map((v) => (
            <li key={v.id}>
              <button
                onClick={() => chooseVc(v.id)}
                className="group flex w-full items-center gap-5 p-5 text-left transition first:rounded-t-xl last:rounded-b-xl hover:bg-accent/10 active:scale-[0.99]"
              >
                <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-line text-foreground transition group-hover:bg-accent group-hover:text-white">
                  <Dog size={36} weight="duotone" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-xl font-extrabold tracking-tight">{v.name}</span>
                  <span className="text-sm text-muted">{v.breed}. {v.tagline}</span>
                </span>
                <CaretRight
                  size={22}
                  weight="bold"
                  className="shrink-0 text-muted transition group-hover:translate-x-1 group-hover:text-accent"
                />
              </button>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-5 py-8 sm:px-8">
      {scoring && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background/95">
          <Dog size={72} weight="duotone" className="animate-pulse text-accent" />
          <p className="text-3xl font-black tracking-tighter">{vc.name} is deliberating</p>
          <p className="text-muted">Tallying the damage.</p>
        </div>
      )}

      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-muted">
          <PawPrint size={20} weight="fill" className="text-accent" />
          Pitch Roaster
        </div>
        <div
          className="rounded-xl border border-line bg-surface px-4 py-2 font-mono text-3xl tabular-nums tracking-tight"
          aria-label="Pitch timer"
        >
          <span className={active ? "text-foreground" : "text-muted"}>{fmtTime(elapsed)}</span>
        </div>
      </header>

      {notices}

      <div className="grid flex-1 content-start gap-8 lg:grid-cols-[5fr_7fr] lg:items-start">
        <section className="flex flex-col gap-6 rounded-xl border border-line bg-surface/60 p-6 lg:sticky lg:top-8">
          <div className="flex items-center gap-4">
            <span
              className={`flex h-20 w-20 shrink-0 items-center justify-center rounded-xl transition ${
                phase === "speaking" ? "bg-accent text-white" : "bg-line text-foreground"
              }`}
            >
              <Dog size={48} weight="duotone" />
            </span>
            <div className="min-w-0">
              <p className="text-2xl font-black tracking-tight">{vc.name}</p>
              <p className="text-sm text-muted">{vc.breed}. {vc.tagline}</p>
              {!active && (
                <button
                  onClick={() => setVcId(null)}
                  className="mt-1 text-sm text-muted underline underline-offset-4 transition hover:text-accent"
                >
                  Change VC
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-5">
            <div className="relative flex h-16 w-16 shrink-0 items-center justify-center">
              {listening && (
                <span className="absolute inset-0 rounded-xl bg-accent/40 motion-safe:animate-ping" />
              )}
              <span
                className={`relative flex h-16 w-16 items-center justify-center rounded-xl ${
                  listening ? "bg-accent text-white" : "bg-line text-muted"
                }`}
              >
                <Microphone size={30} weight="fill" />
              </span>
            </div>
            <p className="text-lg font-bold tracking-tight" aria-live="polite">
              {PHASE_LABEL[phase]}
            </p>
          </div>

          {!active ? (
            <button
              onClick={start}
              disabled={!supported || scoring}
              className="rounded-xl bg-accent px-6 py-4 text-lg font-extrabold text-white transition hover:brightness-110 active:translate-y-px active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Start pitch
            </button>
          ) : (
            <button
              onClick={endPitch}
              className="flex items-center justify-center gap-2 rounded-xl border border-foreground/30 px-6 py-4 text-lg font-extrabold transition hover:bg-foreground hover:text-background active:translate-y-px active:scale-[0.98]"
            >
              <Stop size={22} weight="fill" />
              End pitch
            </button>
          )}
        </section>

        <div className="flex min-w-0 flex-col gap-8">
          {question && (
            <section key={log.length} role="alert" className="slam relative">
              <div className="flash pointer-events-none fixed inset-0 z-40 bg-accent/25" />
              <div className="rounded-xl border-2 border-accent bg-accent/10 p-6 shadow-[0_12px_40px_-12px_rgba(224,69,47,0.5)]">
                <p className="flex items-center gap-2 text-sm font-extrabold uppercase tracking-widest text-accent">
                  <Bone size={20} weight="fill" />
                  Interruption
                </p>
                <p className="mt-3 text-3xl font-black leading-[1.1] tracking-tighter sm:text-4xl">
                  {question}
                </p>
              </div>
            </section>
          )}

          <section aria-live="polite">
            <h2 className="mb-3 text-sm font-semibold text-muted">Live transcript</h2>
            <div className="min-h-40 whitespace-pre-wrap rounded-xl border border-line bg-surface/60 p-5 text-lg leading-relaxed">
              {finalText || interim ? (
                <>
                  {finalText}
                  {interim && <span className="text-muted"> {interim}</span>}
                </>
              ) : (
                <span className="text-muted">Your pitch will appear here.</span>
              )}
            </div>
          </section>

          {error && <p className="text-accent">{error}</p>}

          {log.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-muted">Questions and answers</h2>
              <ol className="flex flex-col divide-y divide-line border-y border-line">
                {log.map((entry, i) => {
                  const isLast = i === log.length - 1;
                  const answer = isLast ? (entry.answer + " " + liveAnswer).trim() : entry.answer;
                  return (
                    <li key={i} className="py-4">
                      <p className="font-bold text-accent">{entry.question}</p>
                      <p className="mt-2 whitespace-pre-wrap text-foreground/90">
                        {answer || <span className="text-muted">Waiting for your answer.</span>}
                      </p>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
