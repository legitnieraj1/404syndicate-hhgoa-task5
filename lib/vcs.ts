export type VcId = "shark" | "numbers" | "skeptic";

export type Vc = {
  id: VcId;
  name: string;
  emoji: string;
  tagline: string;
  /** Personality, injected into the interruption and scoring prompts. */
  persona: string;
  voice: {
    /** Preferred browser voice names, in order; falls back to any English voice. */
    prefer: string[];
    pitch: number;
    rate: number;
  };
};

export const VCS: Record<VcId, Vc> = {
  shark: {
    id: "shark",
    name: "The Shark",
    emoji: "🦈",
    tagline: "Aggressive. Impatient. Already bored.",
    persona: `You are "The Shark": an aggressive, impatient, ego-driven VC who hates waste of time.
You cut people off, speak in blunt clipped sentences, and sneer. You respect only hunger, speed and guts.`,
    voice: {
      prefer: ["Daniel", "Alex", "Google UK English Male", "Fred", "Microsoft David", "Microsoft Mark"],
      pitch: 0.75,
      rate: 1.25,
    },
  },
  numbers: {
    id: "numbers",
    name: "The Numbers Guy",
    emoji: "📊",
    tagline: "Only cares about metrics. Feelings are not a KPI.",
    persona: `You are "The Numbers Guy": a cold, analytical VC who only cares about metrics: CAC, LTV, margins, burn, growth rate, TAM math.
You are deadpan and precise, you always ask for a specific number, and you distrust any claim without data.`,
    voice: {
      prefer: ["Samantha", "Google US English", "Microsoft Zira", "Karen", "Allison"],
      pitch: 1.0,
      rate: 0.95,
    },
  },
  skeptic: {
    id: "skeptic",
    name: "The Skeptic",
    emoji: "🧐",
    tagline: "Thinks every startup is just a feature.",
    persona: `You are "The Skeptic": a smug, weary VC convinced that every startup is merely a feature of a bigger product
(a feature of Google, Apple, Stripe, Notion or Excel). You are sarcastic, dry, and always ask why a big incumbent won't just build this.`,
    voice: {
      prefer: ["Fiona", "Moira", "Tessa", "Google UK English Female", "Microsoft Hazel", "Serena"],
      pitch: 1.2,
      rate: 0.85,
    },
  },
};

export const VC_LIST = Object.values(VCS);

export function getVc(id: unknown): Vc {
  return typeof id === "string" && id in VCS ? VCS[id as VcId] : VCS.shark;
}

export type LogEntry = { question: string; answer: string };

export type Scorecard = {
  clarity: number;
  conviction: number;
  objectionHandling: number;
  marketKnowledge: number;
  bestAnswer: { quote: string; why: string };
  worstAnswer: { quote: string; why: string };
  verdict: { invest: boolean; line: string };
};
