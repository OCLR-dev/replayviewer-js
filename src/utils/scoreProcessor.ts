import type { BeatmapData, HitResult, LazerMod } from '../types/index';
import { Mod, type ModDifficulty } from './modDifficulty';
import { slideDurationMs } from './sliderDuration';
import {
  sliderTickTimes,
  sliderTailCheckTime,
  stableSpinnerRequirementHalfSpins,
  lazerSpinnerRequirementFullSpins,
  lazerSpinnerMaxBonusSpins,
  type SpinnerAngleData,
} from './hitJudge';
import { sliderTickTimesLazer } from '../renderer/SliderGeometryLazer';
import { computeAccTimeline, computeComboTimeline, type ComboFrame } from '../renderer/HUDRenderer';

/** osu! rank grade. Silver variants (`SH`/`SSH`) are only emitted when HD or FL is active. */
export type Grade = 'SSH' | 'SS' | 'SH' | 'S' | 'A' | 'B' | 'C' | 'D';

/**
 * One score-timeline sample, emitted per scoring event and sorted by `time`
 * (beatmap ms). Consumers binary-search the frame array to display score /
 * combo / grade at any playback time; each frame carries the running totals
 * as of that event.
 */
export interface ScoreFrame {
  time:     number;
  score:    number;
  combo:    number;
  maxCombo: number;
  grade:    Grade;
}

// Banker's rounding.
function roundToEven(x: number): number {
  const floor = Math.floor(x);
  const diff  = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Stable ScoreV1 difficulty multiplier (integer 2–7) from raw beatmap stats
 * plus object density. Uses banker's rounding, matching osu!stable.
 */
export function computeDifficultyMultiplier(beatmap: BeatmapData): number {
  const hos = beatmap.hitObjects;
  if (hos.length === 0) return 2;

  const first = hos[0]!.time;
  let lastEnd = first;
  for (const o of hos) {
    let end = o.time;
    if      (o.type === 'spinner') end = o.endTime;
    else if (o.type === 'slider')  end = o.time + slideDurationMs(beatmap, o) * o.slides;
    if (end > lastEnd) lastEnd = end;
  }

  // Stable's integer-second drainTime (/1000 truncates).
  const drainSec = Math.max(1, Math.trunc((lastEnd - first) / 1000));
  const density  = Math.min(16, Math.max(0, (hos.length / drainSec) * 8));

  // Stable uses RAW .osu stats, not mod-adjusted (HR/EZ haven't modified yet).
  const fr  = Math.fround;
  const sum = fr(beatmap.hpDrainRate) + fr(beatmap.overallDifficulty)
            + fr(beatmap.circleSize) + fr(density);
  return Math.max(2, Math.min(7, roundToEven((sum / 38) * 5)));
}

const MOD_MULTIPLIERS: [number, number, number?][] = [
  [Mod.NoFail, 0.5, 1],
  [1 << 1,  0.5 ],   // Easy
  [1 << 8,  0.3 ],   // HalfTime
  [1 << 3,  1.06],   // Hidden
  [Mod.HardRock, 1.06, 1.10],
  [Mod.DoubleTime, 1.12, 1.20],   // Nightcore shares DT's bit
  [1 << 10, 1.12],   // Flashlight
  [1 << 12, 0.9 ],   // SpunOut
  [1 << 7,  0   ],   // Relax
  [1 << 13, 0   ],   // Autopilot
];

/** Product of the stable per-mod score multipliers for a stable mod bitmask. */
export function computeModMultiplier(mods: number, scoreV2 = false): number {
  let m = 1;
  for (const [bit, scoreV1Value, scoreV2Value = scoreV1Value] of MOD_MULTIPLIERS) {
    if ((mods & bit) !== 0) m *= scoreV2 ? scoreV2Value : scoreV1Value;
  }
  return m;
}

// Lazer RateAdjustModHelper.ScoreMultiplier; speed truncated to 0.1 first.
function rateAdjustScoreMultiplier(speed: number): number {
  const truncated = Math.trunc(speed * 10) / 10;
  const offset = truncated - 1;
  return speed >= 1 ? 1 + offset / 5 : 0.6 + offset;
}

// Lazer UsesDefaultConfiguration; HD/HR/FL collapse to 1.0 when customised.
function hasDefaultConfig(mod: LazerMod): boolean {
  return mod.settings === undefined || Object.keys(mod.settings).length === 0;
}

/**
 * Taiko Standardised/ScoreV2 mod multiplier from lazer acronym mods. Differs
 * from the V1 bitmask table only in DT/NC (rate-derived, 1.10 at 1.5×) and in
 * HD/HR/FL collapsing to 1.0 when the mod has customised settings.
 */
export function computeTaikoModMultiplierV2(lazerMods: readonly LazerMod[]): number {
  let m = 1;
  for (const mod of lazerMods) {
    switch (mod.acronym) {
      case 'NF': m *= 0.5; break;
      case 'EZ': m *= 0.5; break;
      case 'HD': m *= hasDefaultConfig(mod) ? 1.06 : 1.0; break;
      case 'HR': m *= hasDefaultConfig(mod) ? 1.06 : 1.0; break;
      case 'FL': m *= hasDefaultConfig(mod) ? 1.12 : 1.0; break;
      case 'DT':
      case 'NC': {
        const sc = mod.settings?.['speed_change'];
        const speed = typeof sc === 'number' ? sc : 1.5;
        m *= rateAdjustScoreMultiplier(speed);
        break;
      }
      case 'HT':
      case 'DC': {
        const sc = mod.settings?.['speed_change'];
        const speed = typeof sc === 'number' ? sc : 0.75;
        m *= rateAdjustScoreMultiplier(speed);
        break;
      }
    }
  }
  return m;
}



function computeGrade(
  c300: number, c100: number, c50: number, miss: number, mods: number,
): Grade {
  const total = c300 + c100 + c50 + miss;
  if (total === 0) return 'D';

  const r300 = c300 / total;
  const r50  = c50  / total;

  let g: Grade;
  if      (c300 === total)                                     g = 'SS';
  else if (r300 > 0.9 && r50 < 0.01 && miss === 0)             g = 'S';
  else if ((r300 > 0.8 && miss === 0) || r300 > 0.9)           g = 'A';
  else if ((r300 > 0.7 && miss === 0) || r300 > 0.8)           g = 'B';
  else if (r300 > 0.6)                                         g = 'C';
  else                                                         g = 'D';

  const silver = (mods & ((1 << 3) | (1 << 10))) !== 0;   // HD or FL
  if (silver) {
    if (g === 'S')  return 'SH';
    if (g === 'SS') return 'SSH';
  }
  return g;
}

type SubKind = 'tick' | 'repeat' | 'tail';
type SliderSubEvent = { time: number; kind: SubKind };

function buildSliderSubEvents(beatmap: BeatmapData, isLazer: boolean): Map<number, SliderSubEvent[]> {
  const m = new Map<number, SliderSubEvent[]>();
  for (let i = 0; i < beatmap.hitObjects.length; i++) {
    const obj = beatmap.hitObjects[i]!;
    if (obj.type !== 'slider') continue;
    const slideDur = slideDurationMs(beatmap, obj);
    // Must match hitJudge.ts tick emission (lazer distance-based vs stable time-interval).
    const ticks = isLazer
      ? sliderTickTimesLazer(beatmap, obj, slideDur)
      : sliderTickTimes(beatmap, obj, slideDur);
    const events: SliderSubEvent[] = [];
    for (const time of ticks) events.push({ time, kind: 'tick' });
    for (let edge = 1; edge < obj.slides; edge++) {
      events.push({ time: obj.time + slideDur * edge, kind: 'repeat' });
    }
    events.sort((a, b) => a.time - b.time);
    const duration = slideDur * obj.slides;
    const tailTime = isLazer ? obj.time + duration
      : sliderTailCheckTime(obj.time, duration, events[events.length - 1]?.time ?? obj.time);
    events.push({ time: tailTime, kind: 'tail' });
    m.set(i, events);
  }
  return m;
}

function stableSpinnerSpinValue(halfSpin: number, requirement: number, bonusValue: number): number {
  const afterGap = halfSpin - (requirement + 3);
  if (afterGap > 0 && afterGap % 2 === 0) return bonusValue;
  return halfSpin % 2 === 0 ? 100 : 0;
}

// Stable spinner spin score (danser scorev1 spinner.go / hitresult.go ScoreValue):
// scoringRotationCount counts HALF-spins. At each increment c>1, danser awards exactly one
// of: SpinnerBonus (1100) when c past requirement+3 with matching parity, else SpinnerPoints
// (100) on even c (a full spin), else SpinnerSpin (0). All are RawHits → flat, no combo/mod
// scaling. We replay the increments c=2..floor(totalRad/π) to match the parity exactly.
function stableSpinnerSpinScore(od: number, durationMs: number, totalRad: number, bonusValue: number): number {
  const req = stableSpinnerRequirementHalfSpins(od, durationMs);
  const halfSpins = Math.floor(totalRad / Math.PI);
  let score = 0;
  for (let c = 2; c <= halfSpins; c++) {
    score += stableSpinnerSpinValue(c, req, bonusValue);
  }
  return score;
}

// Lazer spinner bonusPortion (Spinner.cs nested ticks + ScoreProcessor.GetBaseScoreForResult):
// each completed FULL spin triggers the next tick — the first SpinsRequired+gap(2) are
// SpinnerTick (SmallBonus = 10), the rest are SpinnerBonusTick (LargeBonus = 50), capped at
// MaximumBonusSpins. Bonus is added raw (outside the 0–1M combo/acc normalisation).
function lazerSpinnerBonusPortion(od: number, durationMs: number, totalRad: number): number {
  const req      = lazerSpinnerRequirementFullSpins(od, durationMs);
  const maxBonus = lazerSpinnerMaxBonusSpins(od, durationMs);
  const spins    = Math.floor(totalRad / (2 * Math.PI));
  const small = Math.min(spins, req + 2);
  const large = Math.max(0, Math.min(spins - req - 2, maxBonus));
  return small * 10 + large * 50;
}

type ComboOp = 'increment' | 'reset' | 'hold';

interface ScoreEvent {
  time:   number;
  // raw = flat (ticks/ends/bonus); scaled = combo-scaled Hit300/100/50.
  kind:   'raw' | 'scaled' | 'bonus';
  value:  number;
  combo:  ComboOp;
  // null = excluded from acc/grade.
  counts: 300 | 100 | 50 | 0 | null;
}

/**
 * Build the osu!standard score/combo/grade timeline from judged hit results.
 * Uses stable ScoreV1 or ScoreV2, or lazer standardised scoring. Returned
 * frames are sorted by time (beatmap ms), one per scoring event.
 */
export function computeScoreTimeline(
  results: readonly HitResult[],
  beatmap: BeatmapData,
  modDiff: ModDifficulty,
  spinnerAngles?: ReadonlyMap<number, SpinnerAngleData>,
): ScoreFrame[] {
  if (modDiff.isLazer) return computeScoreV3Timeline(results, beatmap, modDiff);
  if (modDiff.isScoreV2) return computeStableScoreV2Timeline(results, beatmap, modDiff, spinnerAngles);
  return computeScoreV1Timeline(results, beatmap, modDiff);
}

/** Score, accuracy and combo timelines shared by analysis and playback. */
export function computeStdScoreTimelines(
  results: readonly HitResult[],
  beatmap: BeatmapData,
  modDiff: ModDifficulty,
  spinnerAngles: ReadonlyMap<number, SpinnerAngleData>,
) {
  const scoreFrames = computeScoreTimeline(results, beatmap, modDiff, spinnerAngles);
  let comboFrames: ComboFrame[];
  if (modDiff.isScoreV2) {
    // Use the same event order as scoring and animate only actual combo changes.
    comboFrames = [];
    let previousCombo = 0;
    for (const { time, combo } of scoreFrames) {
      if (combo !== previousCombo) comboFrames.push({ time, combo });
      previousCombo = combo;
    }
  } else {
    comboFrames = computeComboTimeline(results);
  }
  return { scoreFrames, accFrames: computeAccTimeline(results, modDiff.isScoreV2), comboFrames };
}

function compareStableScoreEvents(a: ScoreEvent, b: ScoreEvent): number {
  // Equal-time slider subs and spinner bonuses apply before the main judgement.
  return a.time - b.time || Number(a.kind === 'scaled') - Number(b.kind === 'scaled');
}

function buildStableScoreEvents(
  results: readonly HitResult[],
  beatmap: BeatmapData,
  modDiff: ModDifficulty,
  sliderSubs: ReadonlyMap<number, SliderSubEvent[]>,
  spinnerAngles?: ReadonlyMap<number, SpinnerAngleData>,
): ScoreEvent[] {
  // Translate each HitResult into one or two ScoreEvents. Slider main results
  // split into SliderStart (at head time) + final Hit300/100/50 (at tail time)
  // so intermediate score/combo updates line up with stable's event ordering.
  const events: ScoreEvent[] = [];
  const subCursor = new Map<number, number>();

  for (const r of results) {
    const objIdx = r.objectIndex;
    const obj    = beatmap.hitObjects[objIdx]!;

    if (r.isSliderSub === true) {
      const idx  = subCursor.get(objIdx) ?? 0;
      subCursor.set(objIdx, idx + 1);
      const kind = sliderSubs.get(objIdx)?.[idx]?.kind ?? 'tick';
      const hit  = r.judgement !== 0;

      if (hit) {
        events.push({
          time: r.time, kind: 'raw',
          value: kind === 'tick' ? 10 : 30,
          combo: 'increment', counts: null,
        });
      } else {
        // Tail miss does not break combo; tick/repeat miss does.
        events.push({
          time: r.time, kind: 'raw', value: 0,
          combo: kind === 'tail' ? 'hold' : 'reset',
          counts: null,
        });
      }
      continue;
    }

    if (obj.type === 'slider') {
      const headHit  = !r.comboBreak;
      const tailTime = r.displayTime ?? r.time;

      events.push({
        time: r.time, kind: 'raw',
        value: headHit ? 30 : 0,
        combo: headHit ? 'increment' : 'reset',
        counts: null,
      });

      if (r.judgement === 0) {
        events.push({
          time: tailTime, kind: 'scaled', value: 0,
          combo: modDiff.isScoreV2 ? 'reset' : 'hold', counts: 0,
        });
      } else {
        // std hitJudge only emits 300|100|50|0; the widened HitResult union (mania 305/200) never reaches here.
        const stdJ = r.judgement as 300 | 100 | 50;
        events.push({
          time: tailTime, kind: 'scaled', value: stdJ,
          combo: 'hold', counts: stdJ,
        });
      }
      continue;
    }

    const hit = r.judgement !== 0;
    if (hit) {
      const stdJ = r.judgement as 300 | 100 | 50;
      events.push({
        time: r.time, kind: 'scaled', value: stdJ,
        combo: 'increment', counts: stdJ,
      });
    } else {
      events.push({
        time: r.time, kind: 'scaled', value: 0,
        combo: 'reset', counts: 0,
      });
    }

    if (obj.type === 'spinner' && r.spinnerTotalRad !== undefined) {
      const duration = obj.endTime - obj.time;
      const angles = spinnerAngles?.get(objIdx);
      if (modDiff.isScoreV2 && angles) {
        const requirement = stableSpinnerRequirementHalfSpins(modDiff.od, duration);
        let halfSpin = 2;
        for (let i = 0; i < angles.times.length; i++) {
          const completed = Math.floor(angles.absAngles[i]! / Math.PI);
          for (; halfSpin <= completed; halfSpin++) {
            const value = stableSpinnerSpinValue(halfSpin, requirement, 500);
            if (value > 0) {
              events.push({ time: angles.times[i]!, kind: 'bonus', value, combo: 'hold', counts: null });
            }
          }
        }
      } else {
        const spin = stableSpinnerSpinScore(modDiff.od, duration, r.spinnerTotalRad, modDiff.isScoreV2 ? 500 : 1100);
        if (spin > 0) {
          events.push({
            time: r.time, kind: modDiff.isScoreV2 ? 'bonus' : 'raw',
            value: spin, combo: 'hold', counts: null,
          });
        }
      }
    }
  }

  return events.sort(compareStableScoreEvents);
}

// Stable ScoreV1; the final frame matches stable's result-screen values.
function computeScoreV1Timeline(
  results: readonly HitResult[],
  beatmap: BeatmapData,
  modDiff: ModDifficulty,
): ScoreFrame[] {
  const diffMult = computeDifficultyMultiplier(beatmap);
  const modMult = computeModMultiplier(modDiff.mods);
  const events = buildStableScoreEvents(results, beatmap, modDiff, buildSliderSubEvents(beatmap, false));
  const frames: ScoreFrame[] = [];
  let score = 0, combo = 0, maxCombo = 0;
  let c300 = 0, c100 = 0, c50 = 0, miss = 0;

  for (const e of events) {
    // Combo-bonus uses (combo - 1) so the first hit of a streak gets no bonus.
    if      (e.combo === 'reset')     combo = 0;
    else if (e.combo === 'increment') combo += 1;
    if (combo > maxCombo) maxCombo = combo;

    const comboBefore = Math.max(combo - 1, 0);

    if (e.kind === 'raw') {
      score += e.value;
    } else if (e.value > 0) {
      const v = e.value;
      score += v + Math.trunc((v * comboBefore * diffMult * modMult) / 25);
    }

    if      (e.counts === 300) c300++;
    else if (e.counts === 100) c100++;
    else if (e.counts === 50)  c50++;
    else if (e.counts === 0)   miss++;

    const grade = computeGrade(c300, c100, c50, miss, modDiff.mods);
    frames.push({ time: e.time, score, combo, maxCombo, grade });
  }

  return frames;
}

function computeStableScoreV2Timeline(
  results: readonly HitResult[],
  beatmap: BeatmapData,
  modDiff: ModDifficulty,
  spinnerAngles?: ReadonlyMap<number, SpinnerAngleData>,
): ScoreFrame[] {
  const maxHits = beatmap.hitObjects.length;
  if (maxHits === 0) return [];

  const modMult = computeModMultiplier(modDiff.mods, true);
  const sliderSubs = buildSliderSubEvents(beatmap, false);

  // Simulate a perfect play on the entire map for the combo denominator.
  const perfect: ScoreEvent[] = [];
  for (let i = 0; i < maxHits; i++) {
    const obj = beatmap.hitObjects[i]!;
    const subs = sliderSubs.get(i);
    if (obj.type === 'slider' && subs) {
      perfect.push({ time: obj.time, kind: 'raw', value: 30, combo: 'increment', counts: null });
      for (const sub of subs) {
        perfect.push({
          time: sub.time, kind: 'raw', value: sub.kind === 'tick' ? 10 : 30,
          combo: 'increment', counts: null,
        });
      }
      const time = obj.time + slideDurationMs(beatmap, obj) * obj.slides;
      perfect.push({ time, kind: 'scaled', value: 300, combo: 'hold', counts: 300 });
    } else {
      const time = obj.type === 'spinner' ? obj.endTime : obj.time;
      perfect.push({ time, kind: 'scaled', value: 300, combo: 'increment', counts: 300 });
    }
  }
  perfect.sort(compareStableScoreEvents);

  // Both totals are stored in tenths so value * (1 + combo / 10) stays exact.
  let maxComboPart = 0, perfectCombo = 0;
  for (const e of perfect) {
    if (e.combo === 'increment') perfectCombo++;
    maxComboPart += e.value * (10 + perfectCombo);
  }

  const events = buildStableScoreEvents(results, beatmap, modDiff, sliderSubs, spinnerAngles);
  const frames: ScoreFrame[] = [];
  let combo = 0, maxCombo = 0, comboPart = 0, bonus = 0;
  let hits = 0, rawScore = 0;
  let c300 = 0, c100 = 0, c50 = 0, miss = 0;

  for (const e of events) {
    if (e.combo === 'reset') combo = 0;
    else if (e.combo === 'increment') combo++;
    maxCombo = Math.max(maxCombo, combo);

    if (e.kind === 'bonus') bonus += e.value;
    else comboPart += e.value * (10 + combo);

    if (e.counts !== null) {
      hits++;
      rawScore += e.counts;
      if      (e.counts === 300) c300++;
      else if (e.counts === 100) c100++;
      else if (e.counts === 50)  c50++;
      else                     miss++;
    }

    // Stable's score uses single-precision accuracy. Only whole objects advance progress.
    const acc = hits > 0 ? Math.fround(Math.fround(rawScore) / Math.fround(300 * hits)) : 1;
    const score = Math.round((700000 * (comboPart / maxComboPart)
      + 300000 * acc ** 10 * (hits / maxHits) + bonus) * modMult);
    const grade = computeGrade(c300, c100, c50, miss, modDiff.mods);
    frames.push({ time: e.time, score, combo, maxCombo, grade });
  }

  return frames;
}

// Lazer per-result base score values. SpinnerBonus omitted (unused).
const SV_BASE          = 300;
const SV_SLIDER_END    = 150;
const SV_SLIDER_START  = 30;
const SV_LEGACY_END    = 10;

// Drives max value, acc-affecting-ness, and miss combo behaviour (tail miss holds combo).
type LzKind = 'base' | 'sliderStart' | 'sliderPoint' | 'sliderRepeat' | 'sliderEnd' | 'legacyEnd';

function lzMaxValue(k: LzKind): number {
  switch (k) {
    case 'base':         return SV_BASE;
    case 'sliderStart':  return SV_SLIDER_START;
    case 'sliderPoint':  return SV_SLIDER_START;
    case 'sliderRepeat': return SV_SLIDER_START;
    case 'sliderEnd':    return SV_SLIDER_END;
    case 'legacyEnd':    return SV_LEGACY_END;
  }
}

// Lazer accuracy: only base hits and SliderEnd count toward acc.
function lzAffectsAcc(k: LzKind): boolean {
  return k === 'base' || k === 'sliderEnd';
}

// Threshold on accuracy (not c300/total); HD/FL → silver.
function computeLazerGrade(accuracy: number, miss: number, mods: number): Grade {
  let g: Grade;
  if      (accuracy >= 1.0)                  g = 'SS';
  else if (accuracy >= 0.95 && miss === 0)   g = 'S';
  else if (accuracy >= 0.90)                 g = 'A';
  else if (accuracy >= 0.80)                 g = 'B';
  else if (accuracy >= 0.70)                 g = 'C';
  else                                       g = 'D';
  const silver = (mods & ((1 << 3) | (1 << 10))) !== 0;
  if (silver) {
    if (g === 'S')  return 'SH';
    if (g === 'SS') return 'SSH';
  }
  return g;
}

// Lazer standardised scoring:
// score = round(round(500000*acc*comboProgress + 500000*acc^5*accProgress + bonus) * modMult).
// CL flips head/tail from base/sliderEnd (acc) to sliderStart/legacyEnd (non-acc); rest identical.
function computeScoreV3Timeline(
  results: readonly HitResult[],
  beatmap: BeatmapData,
  modDiff: ModDifficulty,
): ScoreFrame[] {
  const modMult = computeModMultiplier(modDiff.mods);
  const useLazerSliderAcc = !modDiff.lzNoSliderAcc;
  const sliderSubs = buildSliderSubEvents(beatmap, true);

  // Perfect-play prepass: comboPartMax / accPartMax / maxHits are the denominators.
  let comboPartMax = 0;
  let accPartMax   = 0;
  let maxHits      = 0;
  let cMax         = 0;

  const pushMax = (k: LzKind) => {
    const v = lzMaxValue(k);
    cMax += 1;
    comboPartMax += v * Math.sqrt(cMax);
    if (lzAffectsAcc(k)) {
      accPartMax += v;
      maxHits    += 1;
    }
  };

  for (let i = 0; i < beatmap.hitObjects.length; i++) {
    const obj = beatmap.hitObjects[i]!;
    if (obj.type === 'circle' || obj.type === 'spinner') {
      pushMax('base');
      continue;
    }
    pushMax(useLazerSliderAcc ? 'base' : 'sliderStart');
    const subs = sliderSubs.get(i) ?? [];
    for (const { kind } of subs) {
      if (kind === 'tail') continue;
      pushMax(kind === 'tick' ? 'sliderPoint' : 'sliderRepeat');
    }
    pushMax(useLazerSliderAcc ? 'sliderEnd' : 'legacyEnd');
  }

  interface LzEvent {
    time:     number;
    kind:     LzKind;
    hit:      boolean;
    // base = actual judgement; others = 300 or 0.
    judgement: 300 | 100 | 50 | 0;
    isMain:   boolean;
    counts:   300 | 100 | 50 | 0 | null;
    // Spinner Small/LargeBonus added to bonusPortion (raw, un-normalised). 0 elsewhere.
    bonus?:   number;
  }

  const events: LzEvent[] = [];
  const subCursor = new Map<number, number>();

  for (const r of results) {
    const objIdx = r.objectIndex;
    const obj    = beatmap.hitObjects[objIdx]!;

    if (r.isSliderSub === true) {
      const idx = subCursor.get(objIdx) ?? 0;
      subCursor.set(objIdx, idx + 1);
      const subKind = sliderSubs.get(objIdx)?.[idx]?.kind ?? 'tick';
      const hit = r.judgement !== 0;

      let kind: LzKind;
      if      (subKind === 'tail')   kind = useLazerSliderAcc ? 'sliderEnd' : 'legacyEnd';
      else if (subKind === 'repeat') kind = 'sliderRepeat';
      else                           kind = 'sliderPoint';

      events.push({
        time: r.time,
        kind,
        hit,
        judgement: hit ? 300 : 0,
        isMain: false,
        counts: null,
      });
      continue;
    }

    if (obj.type === 'slider') {
      const headHit = !r.comboBreak;
      if (useLazerSliderAcc) {
        // r.judgement carries the head judgement (see hitJudge useLazerSliderScoring).
        const stdJ = r.judgement as 300 | 100 | 50 | 0;
        events.push({
          time: r.time,
          kind: 'base',
          hit: headHit,
          judgement: stdJ,
          isMain: true,
          counts: stdJ,
        });
      } else {
        // CL: SliderStart (no acc); only comboBreak matters here.
        events.push({
          time: r.time,
          kind: 'sliderStart',
          hit: headHit,
          judgement: headHit ? 300 : 0,
          isMain: true,
          counts: null,
        });
      }
      continue;
    }

    const hit = r.judgement !== 0;
    const stdJ = r.judgement as 300 | 100 | 50 | 0;
    // Spinner contributes Small/LargeBonus on top of its base (Great/Ok/Meh/Miss) hit.
    const bonus = obj.type === 'spinner' && r.spinnerTotalRad !== undefined
      ? lazerSpinnerBonusPortion(modDiff.od, obj.endTime - obj.time, r.spinnerTotalRad)
      : 0;
    events.push({
      time: r.time,
      kind: 'base',
      hit,
      judgement: stdJ,
      isMain: true,
      counts: stdJ,
      bonus,
    });
  }

  // Equal-time: subs process before main events so the tail's combo op runs first.
  events.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return (a.isMain ? 1 : 0) - (b.isMain ? 1 : 0);
  });

  const frames: ScoreFrame[] = [];
  let combo = 0, maxCombo = 0;
  let comboPart = 0;
  let accPart   = 0;
  let bonus     = 0;       // running spinner Small/LargeBonus portion
  let hits      = 0;
  let c300 = 0, c100 = 0, c50 = 0, miss = 0;

  for (const e of events) {
    bonus += e.bonus ?? 0;

    // combo op: base/tick/repeat miss → reset; tail miss → hold.
    if (e.hit) {
      combo += 1;
    } else if (e.kind === 'sliderEnd' || e.kind === 'legacyEnd') {
      // hold — tail miss doesn't break combo
    } else {
      combo = 0;
    }
    if (combo > maxCombo) maxCombo = combo;

    // A missed default-lazer tail spares comboPart even though it hurts acc.
    const missedSliderEnd = !e.hit && e.kind === 'sliderEnd';
    if (!missedSliderEnd) {
      const value = e.hit
        ? (e.kind === 'base' ? e.judgement : lzMaxValue(e.kind))
        : 0;
      comboPart += value * Math.sqrt(combo);
    }

    if (lzAffectsAcc(e.kind)) {
      const value = e.hit
        ? (e.kind === 'base' ? e.judgement : lzMaxValue(e.kind))
        : 0;
      accPart += value;
      hits    += 1;
    }

    if      (e.counts === 300) c300++;
    else if (e.counts === 100) c100++;
    else if (e.counts === 50)  c50++;
    else if (e.counts === 0)   miss++;

    const acc           = accPartMax   > 0 ? accPart   / accPartMax   : 0;
    const comboProgress = comboPartMax > 0 ? comboPart / comboPartMax : 0;
    const accProgress   = maxHits      > 0 ? hits      / maxHits      : 0;
    const inner = 500000 * acc * comboProgress
                + 500000 * Math.pow(acc, 5) * accProgress
                + bonus;
    const score = Math.round(Math.round(inner) * modMult);

    const grade = computeLazerGrade(acc, miss, modDiff.mods);
    frames.push({ time: e.time, score, combo, maxCombo, grade });
  }

  return frames;
}
