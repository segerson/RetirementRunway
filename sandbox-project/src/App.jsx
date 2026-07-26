import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from "recharts";
import { Plus, Trash2, TrendingUp, TrendingDown, Gauge, PlaneTakeoff, HeartPulse, ChevronDown, ChevronUp, Info } from "lucide-react";

const STORAGE_KEY = "retirement-runway-inputs-v2";

const DEFAULT_YOU = {
  name: "",
  currentAge: 40,
  retirementAge: 65,
  lifeExpectancy: 90,
  semiRetirementEnabled: false,
  semiRetirementStartAge: 55,
  semiRetirementEndAge: 62,
  semiRetirementContribution: 8000,
  currentSavings: 250000,
  annualContribution: 20000,
  contributionGrowth: 2,
  preReturn: 7,
  postReturn: 4.5,
  desiredSpending: 70000,
  socialSecurityAnnual: 24000,
  socialSecurityStartAge: 67,
};

const DEFAULT_PARTNER = {
  name: "",
  currentAge: 38,
  retirementAge: 63,
  lifeExpectancy: 92,
  semiRetirementEnabled: false,
  semiRetirementStartAge: 53,
  semiRetirementEndAge: 60,
  semiRetirementContribution: 6000,
  currentSavings: 0,
  annualContribution: 15000,
  contributionGrowth: 2,
  preReturn: 7,
  postReturn: 4.5,
  desiredSpending: 70000,
  socialSecurityAnnual: 18000,
  socialSecurityStartAge: 67,
};

const DEFAULT_JOINT = {
  currentSavings: 250000,
  annualContribution: 35000,
  contributionGrowth: 2,
  preReturn: 7,
  postReturn: 4.5,
  desiredSpending: 90000,
};

const DEFAULTS = {
  monteCarloEnabled: true,
  volatilityMultiplier: 100,
  inflation: 3,
  partnerEnabled: false,
  jointFlags: {
    currentSavings: true,
    contribution: false,
    preReturn: true,
    postReturn: true,
    desiredSpending: true,
  },
  you: DEFAULT_YOU,
  partner: DEFAULT_PARTNER,
  joint: DEFAULT_JOINT,
  expenses: [
    { id: "e1", label: "Kid's college", age: 55, amount: 80000 },
    { id: "e2", label: "New roof / home repair", age: 48, amount: 25000 },
  ],
};

function fmtUSD(n, digits = 0) {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits });
}
function fmtCompact(n) {
  const v = Number.isFinite(n) ? n : 0;
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${sign}$${Math.round(a / 1000)}K`;
  return `${sign}$${Math.round(a)}`;
}

// Seeded PRNG (mulberry32) so the same inputs always produce the same simulated
// paths — otherwise the band would jitter on every unrelated keystroke.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randNormal(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Long-run historical relationship between a portfolio's average nominal return and its
// annualized volatility, anchored to representative US stock/bond blends. Higher assumed
// return implies a more equity-heavy allocation, which historically comes with
// proportionally higher volatility — and vice versa.
const VOL_CURVE = [
  { r: 1, v: 1.5 },
  { r: 3, v: 5 },
  { r: 5, v: 8 },
  { r: 7, v: 11 },
  { r: 9, v: 14.5 },
  { r: 11, v: 18 },
  { r: 13, v: 21.5 },
];

function estimateVolatility(returnPct) {
  const pts = VOL_CURVE;
  if (returnPct <= pts[0].r) {
    const slope = (pts[1].v - pts[0].v) / (pts[1].r - pts[0].r);
    return Math.max(0.5, pts[0].v + slope * (returnPct - pts[0].r));
  }
  const last = pts[pts.length - 1];
  if (returnPct >= last.r) {
    const prev = pts[pts.length - 2];
    const slope = (last.v - prev.v) / (last.r - prev.r);
    return Math.max(0.5, last.v + slope * (returnPct - last.r));
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (returnPct >= a.r && returnPct <= b.r) {
      const frac = (returnPct - a.r) / (b.r - a.r);
      return a.v + frac * (b.v - a.v);
    }
  }
  return last.v;
}

// --- Household simulation engine -------------------------------------------------
// Runs a single pass (deterministic if rng is null, randomized if an rng is supplied)
// over both people at once, sharing one household balance. Each person ages on their
// own timeline (their own current age, retirement age, semi-retirement window, Social
// Security start), while joint-flagged variables (current savings, contribution,
// pre/post return, desired spending) collapse to a single combined number instead of
// two individual ones.
//
// Simplifying assumptions, stated plainly:
//  - The household holds ONE shared balance (not separate his/hers sub-accounts), so a
//    jointly-flagged return assumption is used as-is, and an individually-flagged one is
//    blended as a simple average of whichever phase (pre/post) each person is currently in.
//  - A joint contribution is added once per year (not double-counted) as long as at least
//    one person is in a normal working phase (not retired, not in their own semi-retirement).
//  - Joint desired spending is withdrawn in halves: each retiree "unlocks" half of it as they
//    individually retire, so if one of you retires well before the other, half the household's
//    joint spending starts drawing from savings right away rather than waiting for both of you
//    to stop working. Individual desired spending is withdrawn per-person as soon as that
//    person retires, regardless of the other's status.
//  - Semi-retirement is always individual and always overrides the normal contribution for
//    that person during their window, whether or not the normal contribution is joint.
//  - Social Security / pension is always individual.
function simulateHousehold(p, rng) {
  const you = p.you;
  const partner = p.partnerEnabled ? p.partner : null;
  // Joint flags only mean anything when there's a partner to be joint WITH — force them
  // off otherwise, so single-person mode always reads from you.* (what the UI edits)
  // instead of the unused, un-editable joint.* defaults.
  const jf = p.partnerEnabled ? p.jointFlags : {
    currentSavings: false, contribution: false, preReturn: false, postReturn: false, desiredSpending: false,
  };

  const numYears = 1 + Math.max(
    you.lifeExpectancy - you.currentAge,
    partner ? partner.lifeExpectancy - partner.currentAge : -Infinity
  );

  let balance = jf.currentSavings
    ? p.joint.currentSavings
    : you.currentSavings + (partner ? partner.currentSavings : 0);

  let youContribution = you.annualContribution;
  let partnerContribution = partner ? partner.annualContribution : 0;
  let jointContribution = p.joint.annualContribution;

  const rows = [];
  let depletionAge = null;

  for (let i = 0; i < numYears; i++) {
    const youAge = you.currentAge + i;
    const partnerAge = partner ? partner.currentAge + i : null;

    const youRetired = youAge >= you.retirementAge;
    const youSemi = you.semiRetirementEnabled && youAge >= you.semiRetirementStartAge && youAge <= you.semiRetirementEndAge;
    const partnerRetired = partner ? partnerAge >= partner.retirementAge : false;
    const partnerSemi = partner ? (partner.semiRetirementEnabled && partnerAge >= partner.semiRetirementStartAge && partnerAge <= partner.semiRetirementEndAge) : false;

    // --- Growth: blend whichever phase (pre/post) each person is currently in ---
    const rateFor = (person, retired) => {
      const field = retired ? "postReturn" : "preReturn";
      return jf[field] ? p.joint[field] : person[field];
    };
    const rateList = [rateFor(you, youRetired)];
    if (partner) rateList.push(rateFor(partner, partnerRetired));
    const meanReturnPct = rateList.reduce((a, b) => a + b, 0) / rateList.length;

    let r = meanReturnPct / 100;
    if (rng) {
      const vol = (estimateVolatility(meanReturnPct) * p.volatilityMultiplier) / 100 / 100;
      r = meanReturnPct / 100 + vol * randNormal(rng);
    }
    balance = balance * (1 + r);

    // --- Contributions ---
    let added = 0;
    let jointClaimed = false;
    if (youSemi) {
      added += you.semiRetirementContribution;
    } else if (!youRetired) {
      if (jf.contribution) {
        added += jointContribution;
        jointClaimed = true;
      } else {
        added += youContribution;
        youContribution = Math.max(0, youContribution * (1 + you.contributionGrowth / 100));
      }
    }
    if (partner) {
      if (partnerSemi) {
        added += partner.semiRetirementContribution;
      } else if (!partnerRetired) {
        if (jf.contribution) {
          if (!jointClaimed) {
            added += jointContribution;
            jointClaimed = true;
          }
        } else {
          added += partnerContribution;
          partnerContribution = Math.max(0, partnerContribution * (1 + partner.contributionGrowth / 100));
        }
      }
    }
    if (jf.contribution) {
      jointContribution = Math.max(0, jointContribution * (1 + p.joint.contributionGrowth / 100));
    }
    balance += added;

    // --- Social Security / pension (always individual) ---
    const inflationFactor = Math.pow(1 + p.inflation / 100, i);
    const ssYou = youAge >= you.socialSecurityStartAge ? you.socialSecurityAnnual * inflationFactor : 0;
    const ssPartner = partner && partnerAge >= partner.socialSecurityStartAge ? partner.socialSecurityAnnual * inflationFactor : 0;

    // --- Desired spending / withdrawal ---
    let withdrawal = 0;
    if (jf.desiredSpending) {
      if (partner) {
        // Each retiree "unlocks" their half of the joint spending as they individually retire —
        // so if the higher earner retires first, that portion of the household's joint spending
        // starts drawing from savings right away, instead of waiting for both of you to stop
        // working (which would wrongly assume the still-working partner's income alone covers
        // the full household budget in the gap).
        const retiredShare = (youRetired ? 0.5 : 0) + (partnerRetired ? 0.5 : 0);
        if (retiredShare > 0) {
          withdrawal += retiredShare * p.joint.desiredSpending * inflationFactor - ssYou - ssPartner;
        }
      } else if (youRetired) {
        withdrawal += p.joint.desiredSpending * inflationFactor - ssYou;
      }
    } else {
      if (youRetired) withdrawal += you.desiredSpending * inflationFactor - ssYou;
      if (partner && partnerRetired) withdrawal += partner.desiredSpending * inflationFactor - ssPartner;
    }
    balance -= withdrawal;

    // --- One-off major expenses (shared list, keyed to your age) ---
    const expensesThisYear = p.expenses
      .filter((e) => e.age === youAge)
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    balance -= expensesThisYear;

    if (balance < 0 && depletionAge === null) depletionAge = youAge;

    rows.push({ age: youAge, balance: Math.round(balance) });
  }

  return { rows, depletionAge, numYears };
}

function runSimulation(p) {
  const sim = simulateHousehold(p, null);

  const youRetireIdx = p.you.retirementAge - p.you.currentAge;
  const partnerRetireIdx = p.partnerEnabled ? (p.partner.retirementAge - p.partner.currentAge) : -Infinity;
  const householdRetirementAge = p.you.currentAge + Math.max(youRetireIdx, partnerRetireIdx);

  const horizonAge = sim.rows[sim.rows.length - 1].age;
  const retirementRow = sim.rows.find((r) => r.age === householdRetirementAge) || sim.rows[sim.rows.length - 1];
  const finalRow = sim.rows[sim.rows.length - 1];
  const yearsInRetirement = Math.max(0, horizonAge - householdRetirementAge);
  const yearsFunded = sim.depletionAge ? Math.max(0, sim.depletionAge - householdRetirementAge) : yearsInRetirement;
  const fundingRatio = yearsInRetirement > 0
    ? Math.max(0, Math.min(150, Math.round((yearsFunded / yearsInRetirement) * 100)))
    : 100;

  return {
    rows: sim.rows,
    depletionAge: sim.depletionAge,
    balanceAtRetirement: retirementRow.balance,
    endingBalance: finalRow.balance,
    fundingRatio,
    yearsFunded,
    yearsInRetirement,
    householdRetirementAge,
    horizonAge,
  };
}

function runMonteCarlo(p, trials = 500) {
  const rng = mulberry32(20260725);
  const trialRows = [];
  let successCount = 0;
  let numYears = 0;

  for (let t = 0; t < trials; t++) {
    const sim = simulateHousehold(p, rng);
    numYears = sim.rows.length;
    trialRows.push(sim.rows);
    if (sim.depletionAge === null) successCount++;
  }

  const percentile = (sortedArr, q) => {
    const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.round(q * (sortedArr.length - 1))));
    return sortedArr[idx];
  };

  const rows = [];
  for (let i = 0; i < numYears; i++) {
    const vals = trialRows.map((r) => r[i].balance).sort((a, b) => a - b);
    rows.push({
      age: trialRows[0][i].age,
      low: Math.round(percentile(vals, 0.05)),
      high: Math.round(percentile(vals, 0.95)),
      median: Math.round(percentile(vals, 0.5)),
    });
  }

  const mult = p.volatilityMultiplier / 100;
  const displayPreReturn = (p.partnerEnabled && p.jointFlags.preReturn) ? p.joint.preReturn : p.you.preReturn;
  const displayPostReturn = (p.partnerEnabled && p.jointFlags.postReturn) ? p.joint.postReturn : p.you.postReturn;

  return {
    rows,
    successRate: Math.round((successCount / trials) * 100),
    trials,
    preVolPct: Math.round(estimateVolatility(displayPreReturn) * mult * 10) / 10,
    postVolPct: Math.round(estimateVolatility(displayPostReturn) * mult * 10) / 10,
  };
}

// --- Small form controls -----------------------------------------------------------

const INFO_MONTE_CARLO = {
  text: "Monte Carlo simulation runs your plan hundreds of times, each time with randomly varying investment returns, to show a realistic range of outcomes instead of a single what-if number.",
};
const INFO_FUNDING_RATIO = {
  text: "The share of your retirement years the deterministic forecast covers before savings run out — e.g. 80% means the money is projected to last 80% of the way through retirement, not 80% of your full life.",
};
const INFO_INFLATION = {
  text: "U.S. inflation has historically averaged roughly 3% per year over the long run, though it's been as low as near 0% and as high as 8%+ in individual years.",
};
const INFO_SEMI_CONTRIB = {
  text: "During semi-retirement, it's common for retirement contributions to fall — and potentially even turn slightly negative — as part-time income covers less of your expenses than full-time work did.",
};
const INFO_PRE_RETURN = {
  text: "Historically, a diversified stock portfolio has returned roughly 7–10% per year on average before inflation, though any single year can vary well above or below that average.",
};
const INFO_POST_RETURN = {
  text: "Most financial advisors recommend shifting toward more conservative investments as retirement progresses, to reduce the risk that a market downturn early in retirement forces you to sell assets at a loss.",
};
const INFO_SOCIAL_SECURITY = {
  text: "You can look up your own personalized estimated benefit, based on your actual earnings record, through the Social Security Administration.",
  link: "https://www.ssa.gov/myaccount/",
  linkLabel: "ssa.gov — my Social Security",
};

function InfoTip({ text, link, linkLabel }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", verticalAlign: "middle" }}>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        aria-label="More info"
        style={{ background: "transparent", border: "none", padding: 0, margin: "0 0 0 5px", cursor: "pointer", color: "#5E6885", display: "inline-flex", alignItems: "center", lineHeight: 0 }}
      >
        <Info size={13} />
      </button>
      {open && (
        <div
          style={{
            position: "absolute", zIndex: 30, top: 20, left: 0, width: 240,
            background: "#0E1426", border: "1px solid #2A3355", borderRadius: 8,
            padding: "10px 12px", fontFamily: "Inter, sans-serif", fontSize: 11.5,
            color: "#C7CEDC", lineHeight: 1.5, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}
        >
          {text}
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: "block", marginTop: 6, color: "#B98B3E", fontSize: 11, textDecoration: "none" }}
            >
              {linkLabel || link} ↗
            </a>
          )}
        </div>
      )}
    </span>
  );
}

function TextField({ label, value, onChange, placeholder, info }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      {label && (
        <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
          <span style={{ fontFamily: "Inter, sans-serif", fontSize: 12.5, color: "#8A93A6", letterSpacing: "0.01em", display: "flex", alignItems: "center" }}>
            {label}
            {info && <InfoTip {...info} />}
          </span>
        </div>
      )}
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          background: "#0E1426",
          border: "1px solid #2A3355",
          borderRadius: 6,
          color: "#F0EAD8",
          fontFamily: "Inter, sans-serif",
          fontSize: 13,
          padding: "7px 9px",
        }}
      />
    </label>
  );
}

function NumberField({ label, value, onChange, suffix, min, max, step = 1, hint, info, compact }) {
  return (
    <label style={{ display: "block", marginBottom: compact ? 0 : 14 }}>
      {label && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
          <span style={{ fontFamily: "Inter, sans-serif", fontSize: 12.5, color: "#8A93A6", letterSpacing: "0.01em", display: "flex", alignItems: "center" }}>
            {label}
            {info && <InfoTip {...info} />}
          </span>
          {hint && (
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#B98B3E" }}>{hint}</span>
          )}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {!compact && (
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            className="runway-slider"
            style={{ flex: 1 }}
          />
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 2, flex: compact ? 1 : "initial" }}>
          <input
            type="number"
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            style={{
              width: compact ? "100%" : 74,
              background: "#0E1426",
              border: "1px solid #2A3355",
              borderRadius: 6,
              color: "#F0EAD8",
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 13,
              padding: "5px 6px",
              textAlign: "right",
            }}
          />
          {suffix && <span style={{ color: "#8A93A6", fontSize: 12, fontFamily: "Inter, sans-serif" }}>{suffix}</span>}
        </div>
      </div>
    </label>
  );
}

function MiniTextInput({ label, value, onChange, placeholder }) {
  return (
    <label style={{ display: "block", marginBottom: 8 }}>
      {label && (
        <div style={{ display: "flex", alignItems: "center", fontFamily: "Inter, sans-serif", fontSize: 10.5, color: "#8A93A6", marginBottom: 2 }}>
          {label}
        </div>
      )}
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          background: "#0E1426",
          border: "1px solid #2A3355",
          borderRadius: 6,
          color: "#F0EAD8",
          fontFamily: "Inter, sans-serif",
          fontSize: 12,
          padding: "6px 7px",
        }}
      />
    </label>
  );
}

function MiniNumberInput({ label, value, onChange, suffix, min, max, step = 1, info }) {
  return (
    <label style={{ display: "block", marginBottom: 8 }}>
      {label && (
        <div style={{ display: "flex", alignItems: "center", fontFamily: "Inter, sans-serif", fontSize: 10.5, color: "#8A93A6", marginBottom: 2 }}>
          {label}
          {info && <InfoTip {...info} />}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{
            width: "100%",
            background: "#0E1426",
            border: "1px solid #2A3355",
            borderRadius: 6,
            color: "#F0EAD8",
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 12,
            padding: "6px 7px",
          }}
        />
        {suffix && <span style={{ color: "#8A93A6", fontSize: 10.5, fontFamily: "Inter, sans-serif" }}>{suffix}</span>}
      </div>
    </label>
  );
}

function SelectField({ label, value, onChange, options }) {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <div style={{ fontFamily: "Inter, sans-serif", fontSize: 12, color: "#8A93A6", marginBottom: 4 }}>
        {label}
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          background: "#0E1426",
          border: "1px solid #2A3355",
          borderRadius: 6,
          color: "#F0EAD8",
          fontFamily: "Inter, sans-serif",
          fontSize: 12.5,
          padding: "7px 8px",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

function ToggleSwitch({ checked, onChange, label, hint, info, compact }) {
  return (
    <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", marginBottom: compact ? 0 : 14, gap: 12 }}>
      <span>
        <span style={{ display: "flex", alignItems: "center", fontFamily: "Inter, sans-serif", fontSize: 12.5, color: "#F0EAD8" }}>
          {label}
          {info && <InfoTip {...info} />}
        </span>
        {!compact && hint && <span style={{ display: "block", fontFamily: "Inter, sans-serif", fontSize: 11, color: "#8A93A6", marginTop: 1 }}>{hint}</span>}
      </span>
      <span style={{ position: "relative", width: 36, height: 20, flexShrink: 0, display: "inline-block" }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          style={{ opacity: 0, width: 36, height: 20, margin: 0, position: "absolute", cursor: "pointer" }}
        />
        <span style={{ position: "absolute", inset: 0, background: checked ? "#B98B3E" : "#2A3355", borderRadius: 10, transition: "background 0.15s", pointerEvents: "none" }} />
        <span style={{ position: "absolute", top: 2, left: checked ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: "#F0EAD8", transition: "left 0.15s", pointerEvents: "none" }} />
      </span>
    </label>
  );
}

// Long-run historical relationship between a portfolio's stock allocation and its average
// nominal annual return (illustrative, US, same spirit as VOL_CURVE). Used only for the
// pre-retirement return field, to show roughly how aggressive an assumption implies.
const STOCK_ALLOCATION_CURVE = [
  { stock: 0, r: 4 },
  { stock: 20, r: 5 },
  { stock: 40, r: 6 },
  { stock: 60, r: 7.5 },
  { stock: 80, r: 9 },
  { stock: 100, r: 10.5 },
];

function estimateStockAllocation(returnPct) {
  const pts = STOCK_ALLOCATION_CURVE;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (returnPct <= first.r) return { stock: 0, exceeds: false, below: returnPct < first.r };
  if (returnPct >= last.r) return { stock: 100, exceeds: returnPct > last.r, below: false };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (returnPct >= a.r && returnPct <= b.r) {
      const frac = (returnPct - a.r) / (b.r - a.r);
      return { stock: Math.round(a.stock + frac * (b.stock - a.stock)), exceeds: false, below: false };
    }
  }
  return { stock: 100, exceeds: true, below: false };
}

const INFO_ALLOCATION = {
  text: "This estimates the historical stock/bond mix that has, on average, produced a return around this level — a rough gauge of how aggressive this assumption implicitly is, not a recommendation.",
};

function AllocationIndicator({ returnPct, compact }) {
  const { stock, exceeds } = estimateStockAllocation(returnPct);
  return (
    <div
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        background: "#0E1426", border: "1px solid #2A3355", borderRadius: 6,
        padding: compact ? "3px 7px" : "5px 10px",
        marginTop: compact ? 2 : 0, marginBottom: compact ? 8 : 14,
        marginLeft: compact ? 0 : 8,
        fontFamily: "'IBM Plex Mono', monospace", fontSize: compact ? 10 : 11, color: "#8A93A6",
      }}
    >
      {exceeds ? (
        <span style={{ color: "#C2542D" }}>exceeds typical all-stock historical avg (~10.5%/yr)</span>
      ) : (
        <>
          ~<span style={{ color: "#D9B872" }}>{stock}% stocks</span> / {100 - stock}% bonds
        </>
      )}
      <InfoTip {...INFO_ALLOCATION} />
    </div>
  );
}

const INFO_DESIRED_SPENDING = {
  text: "Financial advisors usually advise you estimate long-term expenses to be roughly what they are now — your overall spending tends to stay fairly stable in retirement, even as its mix shifts.",
};
const INFO_VOLATILITY = {
  text: "σ (sigma) is the average annual standard deviation in market performance for a portfolio with this expected return — the higher this number, the more the Monte Carlo simulation's likely outcomes will scatter around the central forecast.",
};

function VolIndicator({ returnPct, multiplier, compact }) {
  const vol = Math.round(estimateVolatility(returnPct) * (multiplier / 100) * 10) / 10;
  return (
    <div
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        background: "#0E1426", border: "1px solid #2A3355", borderRadius: 6,
        padding: compact ? "3px 7px" : "5px 10px",
        marginTop: compact ? 2 : -8, marginBottom: compact ? 8 : 14,
        fontFamily: "'IBM Plex Mono', monospace", fontSize: compact ? 10 : 11, color: "#8A93A6",
      }}
    >
      historical σ ≈ <span style={{ color: "#D9B872" }}>{vol}%</span>
      <InfoTip {...INFO_VOLATILITY} />
    </div>
  );
}

function MiniToggle({ checked, onChange, label }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
      {label && <span style={{ fontFamily: "Inter, sans-serif", fontSize: 10.5, color: "#8A93A6" }}>{label}</span>}
      <span style={{ position: "relative", width: 28, height: 16, flexShrink: 0, display: "inline-block" }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          style={{ opacity: 0, width: 28, height: 16, margin: 0, position: "absolute", cursor: "pointer" }}
        />
        <span style={{ position: "absolute", inset: 0, background: checked ? "#B98B3E" : "#2A3355", borderRadius: 8, pointerEvents: "none" }} />
        <span style={{ position: "absolute", top: 2, left: checked ? 14 : 2, width: 12, height: 12, borderRadius: "50%", background: "#F0EAD8", pointerEvents: "none" }} />
      </span>
    </label>
  );
}

function PersonTag({ children, color }) {
  return (
    <div style={{ fontFamily: "Inter, sans-serif", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color, marginBottom: 6 }}>
      {children}
    </div>
  );
}

const YOU_COLOR = "#D9B872";
const PARTNER_COLOR = "#8FA6D9";

function JointToggleRow({ label, joint, onToggle, info }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
      <span style={{ display: "flex", alignItems: "center", fontFamily: "Inter, sans-serif", fontSize: 12.5, color: "#F0EAD8" }}>
        {label}
        {info && <InfoTip {...info} />}
      </span>
      <MiniToggle checked={joint} onChange={onToggle} label="Joint" />
    </div>
  );
}

function LifeExpectancyCalculator({ onApply, currentLifeExpectancy }) {
  const [open, setOpen] = useState(false);
  const [inputs, setInputs] = useState(LE_DEFAULT_INPUTS);
  const estimate = useMemo(() => estimateLifeExpectancy(inputs), [inputs]);
  const setField = (key) => (val) => setInputs((prev) => ({ ...prev, [key]: val }));

  return (
    <div style={{ marginTop: 6, marginBottom: 4 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 6, background: "transparent",
          border: "none", color: "#B98B3E", fontFamily: "Inter, sans-serif",
          fontSize: 12, padding: "2px 0", cursor: "pointer",
        }}
      >
        <HeartPulse size={13} />
        Estimate life expectancy from health factors
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>

      {open && (
        <div style={{ background: "#1B2340", border: "1px solid #2A3355", borderRadius: 8, padding: 14, marginTop: 8 }}>
          <SelectField
            label="Sex"
            value={inputs.sex}
            onChange={setField("sex")}
            options={[
              { value: "female", label: "Female" },
              { value: "male", label: "Male" },
              { value: "other", label: "Prefer not to say / other" },
            ]}
          />
          {Object.keys(LE_FACTORS).map((key) => (
            <SelectField
              key={key}
              label={LE_FACTORS[key].label}
              value={inputs[key]}
              onChange={setField(key)}
              options={LE_FACTORS[key].options}
            />
          ))}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, paddingTop: 10, borderTop: "1px solid #2A3355" }}>
            <div>
              <div style={{ fontFamily: "Inter, sans-serif", fontSize: 11, color: "#8A93A6" }}>Estimated life expectancy</div>
              <div style={{ fontFamily: "'Fraunces', serif", fontSize: 22, color: "#F0EAD8" }}>{estimate}</div>
            </div>
            <button
              onClick={() => onApply(estimate)}
              style={{
                background: "#B98B3E", border: "none", borderRadius: 6, color: "#12182B",
                fontFamily: "Inter, sans-serif", fontWeight: 600, fontSize: 12.5,
                padding: "8px 14px", cursor: "pointer",
              }}
            >
              Apply {estimate} to plan
            </button>
          </div>
          <p style={{ fontFamily: "Inter, sans-serif", fontSize: 10.5, color: "#5E6885", marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
            A rough estimate from general population research trends on the factors most associated with longevity — not medical or actuarial advice. Currently modeling to age {currentLifeExpectancy}.
          </p>
        </div>
      )}
    </div>
  );
}

// Rough, illustrative life-expectancy estimator — general population research trends,
// not a medical or actuarial instrument. For planning-baseline use only.
const LE_BASE = { female: 81, male: 76, other: 79 };

const LE_FACTORS = {
  smoking: {
    label: "Smoking",
    options: [
      { value: "never", label: "Never smoked", delta: 3 },
      { value: "former", label: "Former smoker", delta: 1 },
      { value: "current", label: "Current smoker", delta: -8 },
    ],
  },
  activity: {
    label: "Physical activity",
    options: [
      { value: "sedentary", label: "Sedentary", delta: -3 },
      { value: "moderate", label: "Moderate (~150 min/wk)", delta: 2 },
      { value: "active", label: "Regularly vigorous", delta: 4 },
    ],
  },
  bmi: {
    label: "Body weight (BMI range)",
    options: [
      { value: "under", label: "Underweight", delta: -2 },
      { value: "normal", label: "Normal", delta: 2 },
      { value: "over", label: "Overweight", delta: -1 },
      { value: "obese", label: "Obese", delta: -4 },
    ],
  },
  diet: {
    label: "Diet quality",
    options: [
      { value: "poor", label: "Poor (processed-heavy)", delta: -2 },
      { value: "average", label: "Average", delta: 0 },
      { value: "good", label: "Good (whole foods, veg)", delta: 2 },
    ],
  },
  alcohol: {
    label: "Alcohol use",
    options: [
      { value: "none", label: "None / rare", delta: 0 },
      { value: "moderate", label: "Moderate", delta: 0 },
      { value: "heavy", label: "Heavy", delta: -3 },
    ],
  },
  sleep: {
    label: "Typical sleep",
    options: [
      { value: "short", label: "Under 6 hrs", delta: -2 },
      { value: "healthy", label: "7–8 hrs", delta: 2 },
      { value: "long", label: "Over 9 hrs", delta: -1 },
    ],
  },
  bloodPressure: {
    label: "Blood pressure",
    options: [
      { value: "normal", label: "Normal", delta: 1 },
      { value: "controlled", label: "High, controlled", delta: -1 },
      { value: "high", label: "High, untreated", delta: -3 },
    ],
  },
  social: {
    label: "Social connection",
    options: [
      { value: "strong", label: "Strong ties", delta: 2 },
      { value: "average", label: "Average", delta: 0 },
      { value: "isolated", label: "Isolated", delta: -3 },
    ],
  },
  familyLongevity: {
    label: "Parents lived past 85",
    options: [
      { value: "yes", label: "Yes", delta: 2 },
      { value: "no", label: "No / unsure", delta: 0 },
    ],
  },
  stress: {
    label: "Chronic stress level",
    options: [
      { value: "low", label: "Low", delta: 1 },
      { value: "moderate", label: "Moderate", delta: 0 },
      { value: "high", label: "High", delta: -2 },
    ],
  },
};

const LE_DEFAULT_INPUTS = {
  sex: "other",
  smoking: "never",
  activity: "moderate",
  bmi: "normal",
  diet: "average",
  alcohol: "moderate",
  sleep: "healthy",
  bloodPressure: "normal",
  social: "average",
  familyLongevity: "no",
  stress: "moderate",
};

function estimateLifeExpectancy(inputs) {
  let total = LE_BASE[inputs.sex] ?? LE_BASE.other;
  for (const key of Object.keys(LE_FACTORS)) {
    const factor = LE_FACTORS[key];
    const chosen = factor.options.find((o) => o.value === inputs[key]);
    if (chosen) total += chosen.delta;
  }
  return Math.max(55, Math.min(102, Math.round(total)));
}

function SectionLabel({ children }) {
  return (
    <div
      style={{
        fontFamily: "'Fraunces', serif",
        fontSize: 15,
        color: "#D9B872",
        marginBottom: 12,
        marginTop: 22,
        paddingBottom: 6,
        borderBottom: "1px solid #2A3355",
      }}
    >
      {children}
    </div>
  );
}

function StatCard({ icon, label, value, sub, tone, info }) {
  const toneColor = tone === "good" ? "#6B8F71" : tone === "bad" ? "#C2542D" : "#D9B872";
  return (
    <div
      style={{
        background: "#1B2340",
        border: "1px solid #2A3355",
        borderRadius: 10,
        padding: "16px 18px",
        flex: "1 1 200px",
        minWidth: 200,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, color: "#8A93A6" }}>
        {icon}
        <span style={{ fontFamily: "Inter, sans-serif", fontSize: 12, letterSpacing: "0.03em", textTransform: "uppercase", display: "flex", alignItems: "center" }}>
          {label}
          {info && <InfoTip {...info} />}
        </span>
      </div>
      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 26, color: "#F0EAD8", marginBottom: 4 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: toneColor }}>{sub}</div>
      )}
    </div>
  );
}

function RunwayGauge({ currentAge, retirementAge, lifeExpectancy, depletionAge, semiRetirementEnabled, semiRetirementStartAge, semiRetirementEndAge, personLabel, accentColor }) {
  const start = currentAge;
  const end = Math.max(lifeExpectancy, depletionAge || 0) + 1;
  const span = end - start;
  const pct = (age) => ((age - start) / span) * 100;

  // Build solid, non-overlapping segments so each phase reads as a clearly distinct
  // color rather than a translucent tint layered on top of another color.
  const SEG_COLORS = {
    working: "linear-gradient(90deg, #6B8F71, #85A886)",
    semi: "#2FA189",
    retired: "#B98B3E",
    shortfall: "repeating-linear-gradient(135deg, #C2542D, #C2542D 6px, #A8441F 6px, #A8441F 12px)",
  };
  const segments = [];
  let cursor = start;
  if (semiRetirementEnabled) {
    if (semiRetirementStartAge > cursor) segments.push({ from: cursor, to: semiRetirementStartAge, kind: "working" });
    segments.push({ from: semiRetirementStartAge, to: semiRetirementEndAge, kind: "semi" });
    cursor = semiRetirementEndAge;
  } else if (retirementAge > cursor) {
    segments.push({ from: cursor, to: retirementAge, kind: "working" });
    cursor = retirementAge;
  }
  if (depletionAge != null && depletionAge > cursor && depletionAge < end) {
    segments.push({ from: cursor, to: depletionAge, kind: "retired" });
    segments.push({ from: depletionAge, to: end, kind: "shortfall" });
  } else if (depletionAge != null && depletionAge <= cursor) {
    segments.push({ from: cursor, to: end, kind: "shortfall" });
  } else if (end > cursor) {
    segments.push({ from: cursor, to: end, kind: "retired" });
  }

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontFamily: "Inter, sans-serif", fontSize: 12, color: personLabel ? (accentColor || YOU_COLOR) : "#8A93A6", fontWeight: personLabel ? 600 : 400 }}>
          {personLabel ? `${personLabel} \u2013 Age ${start}` : `Age ${start}`}
        </span>
        <span style={{ fontFamily: "Inter, sans-serif", fontSize: 12, color: "#8A93A6" }}>
          Age {end}
        </span>
      </div>
      <div style={{ position: "relative", height: 34, marginTop: 20, marginBottom: semiRetirementEnabled ? 20 : 0 }}>
        <div style={{ position: "absolute", inset: 0, background: "#0E1426", borderRadius: 6, overflow: "hidden", border: "1px solid #2A3355" }}>
          {segments.map((seg, idx) => (
            <div
              key={idx}
              title={`${seg.kind} ${seg.from}\u2013${seg.to}`}
              style={{
                position: "absolute", top: 0, bottom: 0,
                left: `${pct(seg.from)}%`,
                width: `${pct(seg.to) - pct(seg.from)}%`,
                background: SEG_COLORS[seg.kind],
              }}
            />
          ))}
        </div>
        {semiRetirementEnabled && (
          <div
            title={`Semi-retirement starts ${semiRetirementStartAge}`}
            style={{ position: "absolute", top: 0, bottom: 0, left: `${pct(semiRetirementStartAge)}%`, width: 2, background: "#2FA189" }}
          />
        )}
        {semiRetirementEnabled && (
          <div
            style={{
              position: "absolute", left: `${pct(semiRetirementStartAge)}%`, top: -18,
              transform: "translateX(-50%)", fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 10, color: "#2FA189", whiteSpace: "nowrap",
            }}
          >
            semi-retire {semiRetirementStartAge}
          </div>
        )}
        {semiRetirementEnabled && (
          <div
            title={`Semi-retirement ends ${semiRetirementEndAge}`}
            style={{ position: "absolute", top: 0, bottom: 0, left: `${pct(semiRetirementEndAge)}%`, width: 2, background: "#2FA189" }}
          />
        )}
        {semiRetirementEnabled && (
          <div
            style={{
              position: "absolute", left: `${pct(semiRetirementEndAge)}%`, top: 38,
              transform: "translateX(-50%)", fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 10, color: "#2FA189", whiteSpace: "nowrap",
            }}
          >
            ends {semiRetirementEndAge}
          </div>
        )}
        <div
          title={`Retires at ${retirementAge}`}
          style={{ position: "absolute", top: 0, bottom: 0, left: `${pct(retirementAge)}%`, width: 2, background: "#F0EAD8" }}
        />
        <div
          style={{
            position: "absolute", left: `${pct(retirementAge)}%`, top: -18,
            transform: "translateX(-50%)", fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 10, color: "#F0EAD8", whiteSpace: "nowrap",
          }}
        >
          retire {retirementAge}
        </div>
        {depletionAge && (
          <div
            style={{ position: "absolute", top: 0, bottom: 0, left: `${pct(depletionAge)}%`, width: 2, background: "#C2542D" }}
          />
        )}
      </div>
      <div style={{ marginTop: 8, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5 }}>
        {depletionAge ? (
          <span style={{ color: "#C2542D" }}>runway ends age {depletionAge} — {lifeExpectancy - depletionAge} yrs short of plan</span>
        ) : (
          <span style={{ color: "#6B8F71" }}>funded through age {lifeExpectancy} and beyond</span>
        )}
      </div>
    </div>
  );
}

export default function RetirementRunway() {
  const [p, setP] = useState(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.you === "object" && typeof parsed.joint === "object") {
          setP((prev) => ({
            ...prev,
            ...parsed,
            you: { ...prev.you, ...parsed.you },
            partner: { ...prev.partner, ...parsed.partner },
            joint: { ...prev.joint, ...parsed.joint },
            jointFlags: { ...prev.jointFlags, ...parsed.jointFlags },
          }));
        }
      }
    } catch (e) {
      // no saved data yet, or an incompatible older shape — start fresh
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
      } catch (e) {
        // best effort
      }
    }, 500);
    return () => clearTimeout(saveTimer.current);
  }, [p, loaded]);

  const setField = useCallback((key) => (val) => setP((prev) => ({ ...prev, [key]: val })), []);
  const setYou = useCallback((key) => (val) => setP((prev) => ({ ...prev, you: { ...prev.you, [key]: val } })), []);
  const setPartner = useCallback((key) => (val) => setP((prev) => ({ ...prev, partner: { ...prev.partner, [key]: val } })), []);
  const setJoint = useCallback((key) => (val) => setP((prev) => ({ ...prev, joint: { ...prev.joint, [key]: val } })), []);
  const setJointFlag = useCallback((key) => (val) => setP((prev) => ({ ...prev, jointFlags: { ...prev.jointFlags, [key]: val } })), []);

  // Keep each person's retirement age in sync with the end of their own semi-retirement window.
  useEffect(() => {
    if (p.you.semiRetirementEnabled && p.you.retirementAge !== p.you.semiRetirementEndAge) {
      setP((prev) => ({ ...prev, you: { ...prev.you, retirementAge: prev.you.semiRetirementEndAge } }));
    }
  }, [p.you.semiRetirementEnabled, p.you.semiRetirementEndAge, p.you.retirementAge]);

  useEffect(() => {
    if (p.partner.semiRetirementEnabled && p.partner.retirementAge !== p.partner.semiRetirementEndAge) {
      setP((prev) => ({ ...prev, partner: { ...prev.partner, retirementAge: prev.partner.semiRetirementEndAge } }));
    }
  }, [p.partner.semiRetirementEnabled, p.partner.semiRetirementEndAge, p.partner.retirementAge]);

  const sim = useMemo(() => runSimulation(p), [p]);
  const mc = useMemo(() => (p.monteCarloEnabled ? runMonteCarlo(p, 500) : null), [p]);

  const chartRows = useMemo(
    () => sim.rows.map((r, i) => {
      if (!mc) return { age: r.age, balance: r.balance };
      const high = mc.rows[i]?.high ?? r.balance;
      const low = mc.rows[i]?.low ?? r.balance;
      return { age: r.age, balance: r.balance, high, low, band: Math.max(0, high - low) };
    }),
    [sim, mc]
  );

  const addExpense = () => {
    setP((prev) => ({
      ...prev,
      expenses: [
        ...prev.expenses,
        { id: `e${Date.now()}`, label: "New expense", age: prev.you.currentAge + 5, amount: 10000 },
      ],
    }));
  };
  const updateExpense = (id, field, val) => {
    setP((prev) => ({
      ...prev,
      expenses: prev.expenses.map((e) => (e.id === id ? { ...e, [field]: val } : e)),
    }));
  };
  const removeExpense = (id) => {
    setP((prev) => ({ ...prev, expenses: prev.expenses.filter((e) => e.id !== id) }));
  };

  const onTrack = sim.depletionAge === null;
  const worstCaseDepletionAge = mc ? (mc.rows.find((r) => r.low < 0)?.age ?? null) : null;
  const worstCasePartnerAge = p.partnerEnabled && worstCaseDepletionAge != null
    ? p.partner.currentAge + (worstCaseDepletionAge - p.you.currentAge)
    : null;

  // Display names: once a name is entered for either person, swap it in for the generic
  // "You" / "Partner" labels throughout the UI. youNamed tracks whether "you" specifically
  // has a name (so sentences can stay second-person "you" when unnamed, but switch to
  // third-person with the name and matching verb agreement once one is given).
  const youName = p.you.name.trim();
  const partnerName = p.partner.name.trim();
  const youNamed = youName.length > 0;
  const youLabel = youName || "You";
  const partnerLabel = partnerName || "Partner";
  const youPossessive = youName ? `${youName}'s` : "Your";
  const partnerPossessive = partnerName ? `${partnerName}'s` : "Partner's";
  const youSubject = youName || "you";
  const partnerSubject = partnerName || "your partner";

  // Which of you has more calendar years left until your own life expectancy — i.e. who is
  // projected to be the longer-lived partner — plus the actual calendar year that lands on.
  // This drives the simulation horizon (see numYears in simulateHousehold) and is what
  // "Odds of success" is measured against, expressed as a year rather than an age on either
  // person's own scale, since an age alone doesn't say whose age it is.
  const youYearsLeft = p.you.lifeExpectancy - p.you.currentAge;
  const partnerYearsLeft = p.partnerEnabled ? p.partner.lifeExpectancy - p.partner.currentAge : -Infinity;
  const longerLivedIsPartner = partnerYearsLeft > youYearsLeft;
  const survivorYearsLeft = Math.max(youYearsLeft, partnerYearsLeft);
  const survivorCalendarYear = new Date().getFullYear() + survivorYearsLeft;
  const survivorOwnAge = longerLivedIsPartner ? p.partner.lifeExpectancy : p.you.lifeExpectancy;
  const survivorSubject = longerLivedIsPartner ? partnerSubject : youSubject;
  const survivorIsThirdPerson = longerLivedIsPartner ? true : youNamed;
  const survivorPossessive = longerLivedIsPartner ? partnerPossessive : youPossessive;

  // The household balance depletion age is computed on "your" age scale (sim.depletionAge) —
  // translate it to your partner's own age scale for their gauge (same calendar year, different ages).
  const partnerDepletionAge = p.partnerEnabled && sim.depletionAge != null
    ? p.partner.currentAge + (sim.depletionAge - p.you.currentAge)
    : null;

  return (
    <div style={{ background: "#12182B", minHeight: "100%", padding: "28px 28px 40px", fontFamily: "Inter, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        .runway-slider { -webkit-appearance: none; height: 4px; background: #2A3355; border-radius: 2px; outline: none; }
        .runway-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #B98B3E; cursor: pointer; border: 2px solid #F0EAD8; }
        .runway-slider::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: #B98B3E; cursor: pointer; border: 2px solid #F0EAD8; }
        .runway-input:focus { outline: 1px solid #B98B3E; }
      `}</style>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <PlaneTakeoff size={22} color="#B98B3E" />
        <h1 style={{ fontFamily: "'Fraunces', serif", fontWeight: 500, fontSize: 26, color: "#F0EAD8", margin: 0 }}>
          Retirement Runway
        </h1>
      </div>
      <p style={{ color: "#8A93A6", fontSize: 13, margin: "0 0 18px", fontFamily: "Inter, sans-serif" }}>
        A year-by-year model of whether your savings outlast your spending — adjust any parameter to see the runway shift.
      </p>

      <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "center", background: "#1B2340", border: "1px solid #2A3355", borderRadius: 10, padding: "10px 20px", marginBottom: 16 }}>
        <div style={{ minWidth: 170 }}>
          <ToggleSwitch checked={p.monteCarloEnabled} onChange={setField("monteCarloEnabled")} label="Monte Carlo simulation" info={INFO_MONTE_CARLO} compact />
        </div>
        {p.monteCarloEnabled && (
          <div style={{ width: 150 }}>
            <NumberField label="Volatility vs. hist." value={p.volatilityMultiplier} onChange={setField("volatilityMultiplier")} suffix="%" compact />
          </div>
        )}
        <div style={{ width: 110 }}>
          <NumberField label="Inflation" value={p.inflation} onChange={setField("inflation")} suffix="%/yr" info={INFO_INFLATION} compact />
        </div>
        <div style={{ minWidth: 150 }}>
          <ToggleSwitch checked={p.partnerEnabled} onChange={setField("partnerEnabled")} label="Partner / spouse" compact />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: p.partnerEnabled ? "370px 1fr" : "270px 1fr", gap: 24, alignItems: "start" }}>
        <div>
          <SectionLabel>Personal</SectionLabel>
          {p.partnerEnabled ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <PersonTag color={YOU_COLOR}>{youLabel}</PersonTag>
                <MiniTextInput label="Name" value={p.you.name} onChange={setYou("name")} placeholder="You" />
                <MiniNumberInput label="Current age" value={p.you.currentAge} onChange={setYou("currentAge")} />
                <MiniNumberInput label="Retirement age" value={p.you.retirementAge} onChange={setYou("retirementAge")} />
                <MiniNumberInput label="Life expectancy" value={p.you.lifeExpectancy} onChange={setYou("lifeExpectancy")} />
                <LifeExpectancyCalculator onApply={setYou("lifeExpectancy")} currentLifeExpectancy={p.you.lifeExpectancy} />
              </div>
              <div>
                <PersonTag color={PARTNER_COLOR}>{partnerLabel}</PersonTag>
                <MiniTextInput label="Name" value={p.partner.name} onChange={setPartner("name")} placeholder="Partner" />
                <MiniNumberInput label="Current age" value={p.partner.currentAge} onChange={setPartner("currentAge")} />
                <MiniNumberInput label="Retirement age" value={p.partner.retirementAge} onChange={setPartner("retirementAge")} />
                <MiniNumberInput label="Life expectancy" value={p.partner.lifeExpectancy} onChange={setPartner("lifeExpectancy")} />
                <LifeExpectancyCalculator onApply={setPartner("lifeExpectancy")} currentLifeExpectancy={p.partner.lifeExpectancy} />
              </div>
            </div>
          ) : (
            <>
              <TextField label="Name" value={p.you.name} onChange={setYou("name")} placeholder="Optional" />
              <NumberField label="Current age" value={p.you.currentAge} onChange={setYou("currentAge")} min={18} max={80} />
              <NumberField label="Retirement age" value={p.you.retirementAge} onChange={setYou("retirementAge")} min={p.you.currentAge + 1} max={85} />
              <NumberField label="Life expectancy" value={p.you.lifeExpectancy} onChange={setYou("lifeExpectancy")} min={p.you.retirementAge + 1} max={105} />
              <LifeExpectancyCalculator onApply={setYou("lifeExpectancy")} currentLifeExpectancy={p.you.lifeExpectancy} />
            </>
          )}

          <SectionLabel>Semi-retirement</SectionLabel>
          {p.partnerEnabled ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <PersonTag color={YOU_COLOR}>{youLabel}</PersonTag>
                <MiniToggle checked={p.you.semiRetirementEnabled} onChange={setYou("semiRetirementEnabled")} label="Semi-retirement" />
                {p.you.semiRetirementEnabled && (
                  <div style={{ marginTop: 8 }}>
                    <MiniNumberInput label="Starts" value={p.you.semiRetirementStartAge} onChange={setYou("semiRetirementStartAge")} />
                    <MiniNumberInput label="Ends (= retirement age)" value={p.you.semiRetirementEndAge} onChange={setYou("semiRetirementEndAge")} />
                    <MiniNumberInput label="Net contribution/expenses per yr" value={p.you.semiRetirementContribution} onChange={setYou("semiRetirementContribution")} info={INFO_SEMI_CONTRIB} />
                  </div>
                )}
              </div>
              <div>
                <PersonTag color={PARTNER_COLOR}>{partnerLabel}</PersonTag>
                <MiniToggle checked={p.partner.semiRetirementEnabled} onChange={setPartner("semiRetirementEnabled")} label="Semi-retirement" />
                {p.partner.semiRetirementEnabled && (
                  <div style={{ marginTop: 8 }}>
                    <MiniNumberInput label="Starts" value={p.partner.semiRetirementStartAge} onChange={setPartner("semiRetirementStartAge")} />
                    <MiniNumberInput label="Ends (= retirement age)" value={p.partner.semiRetirementEndAge} onChange={setPartner("semiRetirementEndAge")} />
                    <MiniNumberInput label="Net contribution/expenses per yr" value={p.partner.semiRetirementContribution} onChange={setPartner("semiRetirementContribution")} info={INFO_SEMI_CONTRIB} />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <>
              <ToggleSwitch
                checked={p.you.semiRetirementEnabled}
                onChange={setYou("semiRetirementEnabled")}
                label="Semi-retirement phase"
                hint="A working-less-and-earning-less stretch before full retirement"
              />
              {p.you.semiRetirementEnabled && (
                <>
                  <NumberField label="Semi-retirement starts" value={p.you.semiRetirementStartAge} onChange={setYou("semiRetirementStartAge")} min={p.you.currentAge} max={p.you.semiRetirementEndAge} />
                  <NumberField label="Semi-retirement ends (= retirement age)" value={p.you.semiRetirementEndAge} onChange={setYou("semiRetirementEndAge")} min={p.you.semiRetirementStartAge} max={p.you.lifeExpectancy - 1} />
                  <NumberField label="Yearly net contribution / expenses during semi-retirement" value={p.you.semiRetirementContribution} onChange={setYou("semiRetirementContribution")} min={-50000} max={100000} step={500} hint={fmtCompact(p.you.semiRetirementContribution)} info={INFO_SEMI_CONTRIB} />
                </>
              )}
            </>
          )}

          <SectionLabel>Savings & growth</SectionLabel>
          {p.partnerEnabled ? (
            <>
              <JointToggleRow label="Current savings" joint={p.jointFlags.currentSavings} onToggle={setJointFlag("currentSavings")} />
              {p.jointFlags.currentSavings ? (
                <NumberField label="Combined current savings" value={p.joint.currentSavings} onChange={setJoint("currentSavings")} min={0} max={5000000} step={5000} hint={fmtCompact(p.joint.currentSavings)} />
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 6 }}>
                  <MiniNumberInput label={`${youPossessive} savings`} value={p.you.currentSavings} onChange={setYou("currentSavings")} min={0} step={1000} />
                  <MiniNumberInput label={`${partnerPossessive} savings`} value={p.partner.currentSavings} onChange={setPartner("currentSavings")} min={0} step={1000} />
                </div>
              )}

              <JointToggleRow label="Annual contribution & growth" joint={p.jointFlags.contribution} onToggle={setJointFlag("contribution")} />
              {p.jointFlags.contribution ? (
                <>
                  <NumberField label="Combined annual contribution" value={p.joint.annualContribution} onChange={setJoint("annualContribution")} min={0} max={300000} step={1000} hint={fmtCompact(p.joint.annualContribution)} />
                  <NumberField label="Contribution change per year" value={p.joint.contributionGrowth} onChange={setJoint("contributionGrowth")} min={-20} max={10} step={0.5} suffix="%/yr" />
                </>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 6 }}>
                  <div>
                    <PersonTag color={YOU_COLOR}>{youLabel}</PersonTag>
                    <MiniNumberInput label="Contribution/yr" value={p.you.annualContribution} onChange={setYou("annualContribution")} min={0} step={500} />
                    <MiniNumberInput label="Change/yr" value={p.you.contributionGrowth} onChange={setYou("contributionGrowth")} suffix="%" step={0.5} />
                  </div>
                  <div>
                    <PersonTag color={PARTNER_COLOR}>{partnerLabel}</PersonTag>
                    <MiniNumberInput label="Contribution/yr" value={p.partner.annualContribution} onChange={setPartner("annualContribution")} min={0} step={500} />
                    <MiniNumberInput label="Change/yr" value={p.partner.contributionGrowth} onChange={setPartner("contributionGrowth")} suffix="%" step={0.5} />
                  </div>
                </div>
              )}

              <JointToggleRow label="Return before retirement" joint={p.jointFlags.preReturn} onToggle={setJointFlag("preReturn")} info={INFO_PRE_RETURN} />
              {p.jointFlags.preReturn ? (
                <>
                  <NumberField label="Combined pre-retirement return" value={p.joint.preReturn} onChange={setJoint("preReturn")} min={0} max={12} step={0.25} suffix="%/yr" />
                  <VolIndicator returnPct={p.joint.preReturn} multiplier={p.volatilityMultiplier} />
                  <AllocationIndicator returnPct={p.joint.preReturn} />
                </>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 6 }}>
                  <div>
                    <MiniNumberInput label={`${youPossessive} return`} value={p.you.preReturn} onChange={setYou("preReturn")} suffix="%" step={0.25} />
                    <VolIndicator returnPct={p.you.preReturn} multiplier={p.volatilityMultiplier} compact />
                    <AllocationIndicator returnPct={p.you.preReturn} compact />
                  </div>
                  <div>
                    <MiniNumberInput label={`${partnerPossessive} return`} value={p.partner.preReturn} onChange={setPartner("preReturn")} suffix="%" step={0.25} />
                    <VolIndicator returnPct={p.partner.preReturn} multiplier={p.volatilityMultiplier} compact />
                    <AllocationIndicator returnPct={p.partner.preReturn} compact />
                  </div>
                </div>
              )}

              <JointToggleRow label="Return after retirement" joint={p.jointFlags.postReturn} onToggle={setJointFlag("postReturn")} info={INFO_POST_RETURN} />
              {p.jointFlags.postReturn ? (
                <>
                  <NumberField label="Combined post-retirement return" value={p.joint.postReturn} onChange={setJoint("postReturn")} min={0} max={10} step={0.25} suffix="%/yr" />
                  <VolIndicator returnPct={p.joint.postReturn} multiplier={p.volatilityMultiplier} />
                </>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 6 }}>
                  <div>
                    <MiniNumberInput label={`${youPossessive} return`} value={p.you.postReturn} onChange={setYou("postReturn")} suffix="%" step={0.25} />
                    <VolIndicator returnPct={p.you.postReturn} multiplier={p.volatilityMultiplier} compact />
                  </div>
                  <div>
                    <MiniNumberInput label={`${partnerPossessive} return`} value={p.partner.postReturn} onChange={setPartner("postReturn")} suffix="%" step={0.25} />
                    <VolIndicator returnPct={p.partner.postReturn} multiplier={p.volatilityMultiplier} compact />
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <NumberField label="Current savings" value={p.you.currentSavings} onChange={setYou("currentSavings")} min={0} max={5000000} step={5000} hint={fmtCompact(p.you.currentSavings)} />
              <NumberField label="Annual contribution" value={p.you.annualContribution} onChange={setYou("annualContribution")} min={0} max={200000} step={1000} hint={fmtCompact(p.you.annualContribution)} />
              <NumberField label="Contribution change per year" value={p.you.contributionGrowth} onChange={setYou("contributionGrowth")} min={-20} max={10} step={0.5} suffix="%/yr" />
              <NumberField label="Return before retirement" value={p.you.preReturn} onChange={setYou("preReturn")} min={0} max={12} step={0.25} suffix="%/yr" info={INFO_PRE_RETURN} />
              <VolIndicator returnPct={p.you.preReturn} multiplier={p.volatilityMultiplier} />
              <AllocationIndicator returnPct={p.you.preReturn} />
              <NumberField label="Return after retirement" value={p.you.postReturn} onChange={setYou("postReturn")} min={0} max={10} step={0.25} suffix="%/yr" info={INFO_POST_RETURN} />
              <VolIndicator returnPct={p.you.postReturn} multiplier={p.volatilityMultiplier} />
            </>
          )}

          <SectionLabel>Retirement income & spending</SectionLabel>
          {p.partnerEnabled ? (
            <>
              <JointToggleRow label="Desired annual spending" joint={p.jointFlags.desiredSpending} onToggle={setJointFlag("desiredSpending")} info={INFO_DESIRED_SPENDING} />
              {p.jointFlags.desiredSpending ? (
                <NumberField label="Combined desired spending" value={p.joint.desiredSpending} onChange={setJoint("desiredSpending")} min={0} max={400000} step={1000} hint={fmtCompact(p.joint.desiredSpending)} />
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 6 }}>
                  <MiniNumberInput label={`${youPossessive} spending`} value={p.you.desiredSpending} onChange={setYou("desiredSpending")} min={0} step={1000} />
                  <MiniNumberInput label={`${partnerPossessive} spending`} value={p.partner.desiredSpending} onChange={setPartner("desiredSpending")} min={0} step={1000} />
                </div>
              )}

              <div style={{ display: "flex", alignItems: "center", fontFamily: "Inter, sans-serif", fontSize: 12.5, color: "#F0EAD8", marginTop: 14, marginBottom: 6 }}>
                Social Security / pension <span style={{ color: "#5E6885", fontSize: 11, marginLeft: 4 }}>(always individual)</span>
                <InfoTip {...INFO_SOCIAL_SECURITY} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div>
                  <PersonTag color={YOU_COLOR}>{youLabel}</PersonTag>
                  <MiniNumberInput label="Annual amount" value={p.you.socialSecurityAnnual} onChange={setYou("socialSecurityAnnual")} min={0} step={500} />
                  <MiniNumberInput label="Start age" value={p.you.socialSecurityStartAge} onChange={setYou("socialSecurityStartAge")} />
                </div>
                <div>
                  <PersonTag color={PARTNER_COLOR}>{partnerLabel}</PersonTag>
                  <MiniNumberInput label="Annual amount" value={p.partner.socialSecurityAnnual} onChange={setPartner("socialSecurityAnnual")} min={0} step={500} />
                  <MiniNumberInput label="Start age" value={p.partner.socialSecurityStartAge} onChange={setPartner("socialSecurityStartAge")} />
                </div>
              </div>
            </>
          ) : (
            <>
              <NumberField label="Desired annual spending" value={p.you.desiredSpending} onChange={setYou("desiredSpending")} min={0} max={300000} step={1000} hint={fmtCompact(p.you.desiredSpending)} info={INFO_DESIRED_SPENDING} />
              <NumberField label="Social Security / pension" value={p.you.socialSecurityAnnual} onChange={setYou("socialSecurityAnnual")} min={0} max={80000} step={500} hint={fmtCompact(p.you.socialSecurityAnnual)} info={INFO_SOCIAL_SECURITY} />
              <NumberField label="Benefit start age" value={p.you.socialSecurityStartAge} onChange={setYou("socialSecurityStartAge")} min={p.you.retirementAge} max={70} />
            </>
          )}

          <SectionLabel>Major expenses</SectionLabel>
          {p.expenses.map((e) => (
            <div key={e.id} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
              <input
                className="runway-input"
                value={e.label}
                onChange={(ev) => updateExpense(e.id, "label", ev.target.value)}
                style={{ flex: 1, background: "#0E1426", border: "1px solid #2A3355", borderRadius: 6, color: "#F0EAD8", fontFamily: "Inter, sans-serif", fontSize: 12, padding: "6px 8px" }}
              />
              <input
                className="runway-input"
                type="number"
                value={e.age}
                onChange={(ev) => updateExpense(e.id, "age", Number(ev.target.value))}
                title={`${youPossessive} age when it occurs`}
                style={{ width: 48, background: "#0E1426", border: "1px solid #2A3355", borderRadius: 6, color: "#D9B872", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, padding: "6px 4px", textAlign: "center" }}
              />
              <input
                className="runway-input"
                type="number"
                value={e.amount}
                onChange={(ev) => updateExpense(e.id, "amount", Number(ev.target.value))}
                title="Amount"
                style={{ width: 78, background: "#0E1426", border: "1px solid #2A3355", borderRadius: 6, color: "#F0EAD8", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, padding: "6px 6px", textAlign: "right" }}
              />
              <button
                onClick={() => removeExpense(e.id)}
                aria-label="Remove expense"
                style={{ background: "transparent", border: "none", color: "#C2542D", cursor: "pointer", padding: 4 }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <button
            onClick={addExpense}
            style={{
              display: "flex", alignItems: "center", gap: 6, background: "transparent",
              border: "1px dashed #2A3355", borderRadius: 6, color: "#8A93A6",
              fontFamily: "Inter, sans-serif", fontSize: 12.5, padding: "7px 10px", cursor: "pointer", marginTop: 4,
            }}
          >
            <Plus size={14} /> Add expense
          </button>
          {p.partnerEnabled && (
            <p style={{ fontFamily: "Inter, sans-serif", fontSize: 10.5, color: "#5E6885", marginTop: 8, lineHeight: 1.5 }}>
              Expense ages are keyed to {youPossessive.toLowerCase()} age (age {p.you.currentAge} + years from now), regardless of which partner it relates to.
            </p>
          )}
        </div>
        <div>
      <div style={{ marginBottom: 20 }}>
        <SectionLabel>{p.partnerEnabled ? "Joint balance over time" : "Balance over time"}</SectionLabel>
        <div style={{ background: "#1B2340", border: "1px solid #2A3355", borderRadius: 10, padding: "18px 12px 8px" }}>
          <ResponsiveContainer width="100%" height={380}>
            <AreaChart data={chartRows} margin={{ top: 8, right: 18, left: 8, bottom: 4 }}>
              <defs>
                <linearGradient id="balFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#B98B3E" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#B98B3E" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#232B4A" vertical={false} />
              <XAxis
                dataKey="age"
                tick={{ fill: "#8A93A6", fontSize: 11, fontFamily: "IBM Plex Mono, monospace" }}
                axisLine={{ stroke: "#2A3355" }}
                tickLine={false}
                label={{ value: `${youPossessive.toLowerCase()} age`, position: "insideBottomRight", offset: -2, fill: "#8A93A6", fontSize: 11 }}
              />
              <YAxis
                tickFormatter={fmtCompact}
                tick={{ fill: "#8A93A6", fontSize: 11, fontFamily: "IBM Plex Mono, monospace" }}
                axisLine={false}
                tickLine={false}
                width={64}
              />
              <Tooltip
                formatter={(v, name) => {
                  const labels = { balance: "deterministic", high: "95th pct (Monte Carlo)", low: "5th pct (Monte Carlo)" };
                  return [fmtUSD(v), labels[name] || name];
                }}
                labelFormatter={(l) => `${youPossessive.toLowerCase()} age ${l}`}
                contentStyle={{ background: "#0E1426", border: "1px solid #2A3355", borderRadius: 6, color: "#F0EAD8", fontFamily: "IBM Plex Mono, monospace", fontSize: 12 }}
                labelStyle={{ color: "#8A93A6" }}
              />
              <ReferenceLine x={sim.householdRetirementAge} stroke="#F0EAD8" strokeDasharray="3 3" label={{ value: "retire", position: "top", fill: "#F0EAD8", fontSize: 10 }} />
              {p.you.semiRetirementEnabled && (
                <ReferenceLine x={p.you.semiRetirementStartAge} stroke="#6B8F71" strokeDasharray="3 3" label={{ value: "semi-retire", position: "top", fill: "#6B8F71", fontSize: 10 }} />
              )}
              <ReferenceLine y={0} stroke="#C2542D" strokeDasharray="2 2" />
              {sim.depletionAge && (
                <ReferenceLine x={sim.depletionAge} stroke="#C2542D" strokeDasharray="3 3" label={{ value: "runs out", position: "top", fill: "#C2542D", fontSize: 10 }} />
              )}
              {mc && <Area dataKey="low" stackId="band" stroke="none" fill="transparent" isAnimationActive={false} />}
              {mc && <Area dataKey="band" stackId="band" stroke="none" fill="#8A93A6" fillOpacity={0.18} isAnimationActive={false} />}
              <Area type="monotone" dataKey="balance" stroke="#B98B3E" strokeWidth={2} fill="url(#balFill)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 10, fontFamily: "Inter, sans-serif", fontSize: 11.5, color: "#8A93A6" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "#B98B3E", display: "inline-block" }} />
            deterministic forecast
          </span>
          {mc && (
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: "#8A93A6", opacity: 0.5, display: "inline-block" }} />
              5th–95th pct range ({mc.trials} Monte Carlo paths)
            </span>
          )}
        </div>
        <p style={{ color: "#5E6885", fontSize: 11.5, marginTop: 10, fontFamily: "Inter, sans-serif" }}>
          {p.partnerEnabled && (
            <>The household holds one shared balance. "Retire" marks the age both of you have retired; if desired spending is joint, each of you unlocks half of it as you individually retire, rather than waiting for both retirements. The growth rate each year blends whichever phase — pre- or post-retirement — each of you is individually in. </>
          )}
          {mc ? (
            <>The shaded band comes from {mc.trials} simulated paths. Each year's return is drawn from a normal distribution with a standard deviation derived from the historical risk/return relationship across stock/bond blends — roughly {mc.preVolPct}% pre-retirement and {mc.postVolPct}% post-retirement — scalable via the volatility multiplier above. The band shows the 5th–95th percentile balance at each age. "Odds of success" below is the share of paths that never ran out of money before {survivorCalendarYear}, the year {survivorSubject} reach{survivorIsThirdPerson ? "es" : ""} the life expectancy entered above.</>
          ) : (
            <>Showing the deterministic forecast only — turn on Monte Carlo simulation above to see a simulated best/worst-case range and odds of success.</>
          )}
        </p>
      </div>

      {p.partnerEnabled ? (
        <>
          <RunwayGauge
            currentAge={p.you.currentAge}
            retirementAge={p.you.retirementAge}
            lifeExpectancy={p.you.lifeExpectancy}
            depletionAge={sim.depletionAge}
            semiRetirementEnabled={p.you.semiRetirementEnabled}
            semiRetirementStartAge={p.you.semiRetirementStartAge}
            semiRetirementEndAge={p.you.semiRetirementEndAge}
            personLabel={youLabel}
            accentColor={YOU_COLOR}
          />
          <RunwayGauge
            currentAge={p.partner.currentAge}
            retirementAge={p.partner.retirementAge}
            lifeExpectancy={p.partner.lifeExpectancy}
            depletionAge={partnerDepletionAge}
            semiRetirementEnabled={p.partner.semiRetirementEnabled}
            semiRetirementStartAge={p.partner.semiRetirementStartAge}
            semiRetirementEndAge={p.partner.semiRetirementEndAge}
            personLabel={partnerLabel}
            accentColor={PARTNER_COLOR}
          />
        </>
      ) : (
        <RunwayGauge
          currentAge={p.you.currentAge}
          retirementAge={sim.householdRetirementAge}
          lifeExpectancy={sim.horizonAge}
          depletionAge={sim.depletionAge}
          semiRetirementEnabled={p.you.semiRetirementEnabled}
          semiRetirementStartAge={p.you.semiRetirementStartAge}
          semiRetirementEndAge={p.you.semiRetirementEndAge}
        />
      )}

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 22, fontFamily: "Inter, sans-serif", fontSize: 11, color: "#8A93A6" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "linear-gradient(90deg, #6B8F71, #85A886)", display: "inline-block" }} />
          working / funded
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "#2FA189", display: "inline-block" }} />
          semi-retirement
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "#B98B3E", display: "inline-block" }} />
          retired
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "repeating-linear-gradient(135deg, #C2542D, #C2542D 3px, #A8441F 3px, #A8441F 6px)", display: "inline-block" }} />
          shortfall
        </span>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "0 0 26px" }}>
        <StatCard
          icon={<TrendingUp size={14} />}
          label="At retirement"
          value={fmtCompact(sim.balanceAtRetirement)}
          sub={`age ${sim.householdRetirementAge}`}
        />
        <StatCard
          icon={<Gauge size={14} />}
          label="Funding ratio"
          value={`${sim.fundingRatio}%`}
          sub={`${sim.yearsFunded} of ${sim.yearsInRetirement} retirement yrs`}
          tone={sim.fundingRatio >= 100 ? "good" : "bad"}
          info={INFO_FUNDING_RATIO}
        />
        <StatCard
          icon={onTrack ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
          label={onTrack ? `Balance at ${sim.horizonAge}` : "Runway ends"}
          value={onTrack ? fmtCompact(sim.endingBalance) : `age ${sim.depletionAge}`}
          sub={onTrack ? "surplus" : `${sim.horizonAge - sim.depletionAge} yrs short`}
          tone={onTrack ? "good" : "bad"}
        />
        {mc && (
          <>
            <StatCard
              icon={<TrendingUp size={14} />}
              label="Best case (95th pct)"
              value={fmtCompact(mc.rows[mc.rows.length - 1]?.high)}
              sub={`age ${sim.horizonAge}`}
              tone="good"
            />
            <StatCard
              icon={<TrendingDown size={14} />}
              label="Worst case (5th pct)"
              value={
                worstCaseDepletionAge
                  ? `age ${worstCaseDepletionAge}${worstCasePartnerAge != null ? ` (${partnerLabel} age ${worstCasePartnerAge})` : ""}`
                  : fmtCompact(mc.rows[mc.rows.length - 1]?.low)
              }
              sub={worstCaseDepletionAge ? "runs out" : `age ${sim.horizonAge}`}
              tone="bad"
            />
            <StatCard
              icon={<Gauge size={14} />}
              label="Odds of success"
              value={`${mc.successRate}%`}
              sub={p.partnerEnabled
                ? `until ${survivorCalendarYear} (${survivorPossessive} age ${survivorOwnAge}), ${mc.trials} paths`
                : `until ${survivorCalendarYear} (${youPossessive} age ${survivorOwnAge}), ${mc.trials} paths`}
              tone={mc.successRate >= 90 ? "good" : mc.successRate < 70 ? "bad" : undefined}
              info={{
                text: p.partnerEnabled
                  ? `Measured through ${survivorCalendarYear} — the year ${survivorSubject} reach${survivorIsThirdPerson ? "es" : ""} the life expectancy entered above (${survivorPossessive} age ${survivorOwnAge}), whichever of you that turns out to be. Not a fixed cutoff — it updates automatically if either life expectancy changes.`
                  : `Measured through ${survivorCalendarYear}, the year ${youSubject} reach${youNamed ? "es" : ""} the life expectancy entered above (age ${survivorOwnAge}). Updates automatically if you change that assumption.`,
              }}
            />
          </>
        )}
      </div>
        </div>
      </div>
    </div>
  );
}
