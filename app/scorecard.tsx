"use client";

import { useEffect, useState } from "react";
import { ArrowCounterClockwise, Dog } from "@phosphor-icons/react";
import type { Scorecard as Card, Vc } from "@/lib/vcs";

const METRICS: { key: "clarity" | "conviction" | "objectionHandling" | "marketKnowledge"; label: string }[] = [
  { key: "clarity", label: "Clarity" },
  { key: "conviction", label: "Conviction" },
  { key: "objectionHandling", label: "Handling objections" },
  { key: "marketKnowledge", label: "Knowing your market" },
];

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
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      raf = requestAnimationFrame(() => setCount(overall));
      return () => cancelAnimationFrame(raf);
    }
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
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-6xl flex-col gap-14 px-5 py-10 sm:px-8 lg:py-14">
        <header className="flex items-center gap-3 text-sm font-semibold text-muted">
          <Dog size={28} weight="duotone" className="text-accent" />
          Verdict from {vc.name}
        </header>

        <section className="grid items-end gap-10 lg:grid-cols-[5fr_7fr]">
          <div className="relative">
            <div className="text-[9rem] font-black leading-[0.8] tracking-tighter sm:text-[13rem]">
              {count}
            </div>
            <p className="mt-3 text-lg font-semibold text-muted">out of 100</p>
            <div
              className={`stamp absolute right-0 top-2 rounded-xl border-4 px-4 py-1 text-3xl font-black uppercase tracking-widest sm:text-4xl ${
                card.verdict.invest ? "border-foreground text-foreground" : "border-accent text-accent"
              }`}
            >
              {card.verdict.invest ? "Invest" : "Pass"}
            </div>
          </div>
          <p className="text-3xl font-black leading-[1.1] tracking-tighter sm:text-5xl">
            &ldquo;{card.verdict.line}&rdquo;
          </p>
        </section>

        <section className="grid gap-x-12 gap-y-8 sm:grid-cols-2">
          {METRICS.map((m) => (
            <div key={m.key}>
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold text-muted">{m.label}</span>
                <span className="font-mono text-5xl font-bold tabular-nums tracking-tight">
                  {card[m.key]}
                </span>
              </div>
              <div
                className="mt-2 h-1 origin-left rounded-xl bg-accent transition-transform duration-[1600ms] ease-out motion-reduce:transition-none"
                style={{ transform: `scaleX(${shown ? card[m.key] / 100 : 0})` }}
              />
            </div>
          ))}
        </section>

        <section className="grid gap-10 border-t border-line pt-10 lg:grid-cols-2">
          <div>
            <h2 className="text-sm font-semibold text-muted">Best answer</h2>
            <p className="mt-3 text-2xl font-bold leading-snug tracking-tight">
              &ldquo;{card.bestAnswer.quote}&rdquo;
            </p>
            <p className="mt-3 text-muted">{card.bestAnswer.why}</p>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-accent">Worst answer</h2>
            <p className="mt-3 text-2xl font-bold leading-snug tracking-tight text-accent">
              &ldquo;{card.worstAnswer.quote}&rdquo;
            </p>
            <p className="mt-3 text-muted">{card.worstAnswer.why}</p>
          </div>
        </section>

        <div>
          <button
            onClick={onRestart}
            className="flex items-center gap-2 rounded-xl bg-accent px-7 py-4 text-lg font-extrabold text-white transition hover:brightness-110 active:translate-y-px active:scale-[0.98]"
          >
            <ArrowCounterClockwise size={22} weight="bold" />
            Pitch again
          </button>
        </div>
      </div>
    </div>
  );
}
