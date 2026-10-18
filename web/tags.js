// tags.js — things that may change how you snore (factors) and things you
// try to snore less (remedies), plus the "what affects your snoring" maths.

export const FACTORS = [
  { id: "alcohol", label: "Alcohol" },
  { id: "lateMeal", label: "Late meal" },
  { id: "congested", label: "Blocked nose / cold" },
  { id: "tired", label: "Very tired" },
  { id: "sleepingPill", label: "Sleeping pill" },
  { id: "smoked", label: "Smoked" },
  { id: "exercise", label: "Exercised" },
  { id: "onBack", label: "Slept on my back" },
];

export const REMEDIES = [
  { id: "sideSleep", label: "Side sleeping" },
  { id: "nasalStrip", label: "Nasal strip" },
  { id: "nasalSpray", label: "Nasal spray" },
  { id: "mouthguard", label: "Mouth guard" },
  { id: "mouthTape", label: "Mouth tape" },
  { id: "chinStrap", label: "Chin strap" },
  { id: "pillow", label: "Anti-snore pillow" },
  { id: "humidifier", label: "Humidifier" },
];

const BUILT_IN = new Map([...FACTORS, ...REMEDIES].map((t) => [t.id, t]));
const REMEDY_IDS = new Set(REMEDIES.map((t) => t.id));

// Custom tags are stored as "custom:<text>".
export const customId = (text) => "custom:" + text.trim();
export const labelOf = (id) =>
  BUILT_IN.has(id) ? BUILT_IN.get(id).label : id.replace(/^custom:/, "");
export const isRemedy = (id) => REMEDY_IDS.has(id);

// For each tag used on at least MIN_NIGHTS nights and missing on at least
// MIN_NIGHTS others: average Snore Score with vs without it. Negative `delta`
// means it goes with less snoring. Sorted by how big the difference is.
const MIN_NIGHTS = 2;

export function tagImpact(nights) {
  const scored = nights.filter((n) => Number.isFinite(n.snoreScore));
  const ids = new Set(scored.flatMap((n) => (n.meta && n.meta.tags) || []));
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const out = [];
  for (const id of ids) {
    const withTag = scored.filter((n) => n.meta && n.meta.tags && n.meta.tags.includes(id));
    const without = scored.filter((n) => !(n.meta && n.meta.tags && n.meta.tags.includes(id)));
    if (withTag.length < MIN_NIGHTS || without.length < MIN_NIGHTS) continue;
    const a = mean(withTag.map((n) => n.snoreScore));
    const b = mean(without.map((n) => n.snoreScore));
    out.push({ id, label: labelOf(id), remedy: isRemedy(id), withScore: a, withoutScore: b,
               delta: a - b, nightsWith: withTag.length, nightsWithout: without.length });
  }
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}
