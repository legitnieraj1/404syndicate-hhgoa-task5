"use client";

import { useEffect, useState } from "react";
import type { Scorecard as Card, Vc } from "@/lib/vcs";

const METRICS: { key: "clarity" | "conviction" | "objectionHandling" | "marketKnowledge"; label: string }[] = [
  { key: "clarity", label: "Clarity" },
  { key: "conviction", label: "Conviction" },
  { key: "objectionHandling", label: "Handling objections" },
  { key: "marketKnowledge", label: "Knowing your market" },
];

function scoreColor(n: number) {
  if (n >= 70) return "bg-emerald-400";
  if (n >= 40) return "bg-amber-400";
  return "bg-red-600";
}

export default function Scorecard({
  card,
  vc,
  onRestart,
}: {
  card: Card;
  vc: Vc;
  onRestart: () => void;
}) {
  const overall = Math.round(METRICS.reduce((sum, m) => sum + card[m.key], 0) / METRICS.length);
  const [shown, setShown] = useState(false);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let raf = requestAnimationFrame(() => setShown(true));
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 1800);
      setCount(Math.round(overall * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [overall]);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black text-white [background-image:radial-gradient(ellipse_at_top,rgba(220,38,38,0.35),transparent_60%)]">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-10 px-6 py-14">
        <p className="text-sm font-bold uppercase tracking-[0.4em] text-red-500">
          {vc.emoji} {vc.name} has spoken
        </p>

        <div className="relative flex flex-col items-center">
          <div className="text-[9rem] font-black leading-none tracking-tighter text-white drop-shadow-[0_0_40px_rgba(220,38,38,0.8)] sm:text-[12rem]">
            {count}
          </div>
          <div className="-mt-2 text-lg font-semibold uppercase tracking-widest text-neutral-400">
            out of 100
          </div>
          <div
            className={`stamp absolute -right-4 top-1/2 rounded-md border-8 px-4 py-1 text-4xl font-black uppercase tracking-widest sm:-right-24 sm:text-5xl ${
              card.verdict.invest
                ? "border-emerald-400 text-emerald-400"
                : "border-red-600 text-red-600"
            }`}
          >
            {card.verdict.invest ? "Invest" : "Pass"}
          </div>
        </div>

        <p className="max-w-2xl text-center text-2xl font-extrabold italic leading-snug text-red-500 sm:text-3xl">
          “{card.verdict.line}”
        </p>

        <section className="grid w-full gap-5">
          {METRICS.map((m) => (
            <div key={m.key}>
              <div className="mb-1 flex justify-between text-sm font-semibold uppercase tracking-wider">
                <span>{m.label}</span>
                <span className="tabular-nums">{card[m.key]}</span>
              </div>
              <div className="h-4 overflow-hidden rounded-full bg-neutral-800">
                <div
                  className={`h-full rounded-full transition-[width] duration-[1600ms] ease-out ${scoreColor(card[m.key])}`}
                  style={{ width: shown ? `${card[m.key]}%` : "0%" }}
                />
              </div>
            </div>
          ))}
        </section>

        <section className="grid w-full gap-5 sm:grid-cols-2">
          <div className="rounded-2xl border-2 border-emerald-400/60 bg-emerald-400/5 p-5">
            <p className="text-xs font-bold uppercase tracking-widest text-emerald-400">
              Best answer
            </p>
            <p className="mt-2 italic">“{card.bestAnswer.quote}”</p>
            <p className="mt-2 text-sm text-neutral-400">{card.bestAnswer.why}</p>
          </div>
          <div className="rounded-2xl border-2 border-red-600/70 bg-red-600/5 p-5">
            <p className="text-xs font-bold uppercase tracking-widest text-red-500">
              Worst answer
            </p>
            <p className="mt-2 italic">“{card.worstAnswer.quote}”</p>
            <p className="mt-2 text-sm text-neutral-400">{card.worstAnswer.why}</p>
          </div>
        </section>

        <button
          onClick={onRestart}
          className="rounded-full bg-red-600 px-8 py-3 text-lg font-bold uppercase tracking-wider transition hover:bg-red-500"
        >
          Pitch again
        </button>
      </div>
    </div>
  );
}
