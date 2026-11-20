import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { unzipSync } from 'fflate';
import { analyzeReplay, md5, Mod, parseBeatmap, parseReplay } from '../dist/index.js';

const slider = '64,192,1000,2,0,L|164:192,1,100';

function analyze(objects, samples, replayOverrides = {}) {
  const beatmap = parseBeatmap(`osu file format v14

[General]
Mode:0

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:5
ApproachRate:5
SliderMultiplier:1
SliderTickRate:1

[TimingPoints]
0,500,4,2,1,100,1,0

[HitObjects]
${objects.join('\n')}
`);
  const frames = samples.map(([time, x, y, keys], index) => ({
    timeDelta: time - (samples[index - 1]?.[0] ?? 0), x, y, keys,
  }));
  return analyzeReplay(beatmap, { mode: 0, gameVersion: 20241231, mods: Mod.ScoreV2, frames, ...replayOverrides });
}

function followSlider(headOffset) {
  return [
    [800, 64, 192, 0],
    [1000 + headOffset, 64, 192, 1],
    [1464, 156.8, 192, 1],
    [1500, 164, 192, 0],
  ];
}

async function loadReplayPair(replayPath, mapPath) {
  const bytes = await readFile(replayPath);
  const replay = await parseReplay(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  const files = unzipSync(await readFile(mapPath), { filter: file => file.name.endsWith('.osu') });
  const map = Object.values(files).find(file => md5(file) === replay.beatmapHash);
  assert.ok(map, 'The beatmap set must contain the replay’s exact difficulty');
  return { replay, beatmap: parseBeatmap(new TextDecoder().decode(map)) };
}

function judgementCounts(analysis) {
  const counts = { 300: 0, 100: 0, 50: 0, 0: 0 };
  for (const result of analysis.hitResults) {
    if (!result.isSliderSub) counts[result.judgement]++;
  }
  return counts;
}

test('stable SV2 uses strict head windows and counts one slider judgement at its end', () => {
  for (const [offset, judgement, combo, score] of [
    [49, 300, 2, 1_000_000],
    [50, 100, 2, 308_397],
    [100, 50, 2, 210_490],
    [-150, 50, 1, 143_590],
  ]) {
    const analysis = analyze([slider], followSlider(offset));
    assert.equal(analysis.modDiff.isScoreV2, true);
    assert.equal(analysis.hitResults.find(result => !result.isSliderSub).judgement, judgement);
    assert.deepEqual(analysis.accFrames, [{ time: 1500, acc: judgement / 300 }]);
    assert.equal(analysis.comboFrames.at(-1).combo, combo);
    assert.equal(analysis.scoreFrames.at(-1).score, score);
  }

  const missed = analyze([slider], [[2000, 0, 0, 0]]);
  assert.equal(missed.hitResults.find(result => !result.isSliderSub).judgement, 0);
  assert.equal(missed.scoreFrames.at(-1).score, 0);
});

test('SV2 normalizes the weight of ticks, repeats and the tail over a full play', () => {
  const repeatSlider = '64,192,1000,2,0,L|214:192,2,150';
  const track = [
    [1000, 64, 192, 1], [1500, 164, 192, 1], [1600, 184, 192, 1],
    [1750, 214, 192, 1], [2250, 114, 192, 1], [2464, 71.2, 192, 1], [2500, 64, 192, 0],
  ];
  const perfect = analyze([repeatSlider], track);
  assert.deepEqual(perfect.scoreFrames.map(frame => frame.score),
    [38_954, 53_120, 99_157, 115_683, 168_803, 1_000_000]);

  const missedTick = track.map(frame => frame[0] === 1500 ? [1500, 164, 192, 0] : frame);
  const broken = analyze([repeatSlider], missedTick);
  assert.deepEqual(broken.comboFrames.map(frame => [frame.time, frame.combo]),
    [[1000, 1], [1500, 0], [1750, 1], [2250, 2], [2464, 3]]);
  assert.deepEqual(broken.scoreFrames.at(-1), { time: 2500, score: 291_573, combo: 3, maxCombo: 3, grade: 'D' });

  const missedTail = track.map(frame => frame[0] === 2464 ? [2464, 71.2, 192, 0] : frame);
  const held = analyze([repeatSlider], missedTail);
  assert.equal(held.scoreFrames.at(-1).combo, 4);
  assert.equal(held.hitResults.find(result => !result.isSliderSub).judgement, 100);
});

test('SV2 uses map progress and the current combo after a miss', () => {
  const analysis = analyze(
    ['64,192,1000,1,0', '192,192,1600,1,0', '320,192,2200,1,0'],
    [[1000, 64, 192, 1], [1001, 64, 192, 0], [2200, 320, 192, 1]],
  );
  assert.deepEqual(analysis.scoreFrames.map(frame => [frame.score, frame.combo]),
    [[313_889, 1], [214_084, 0], [432_980, 1]]);
  assert.equal(analysis.accFrames.at(-1).acc, 2 / 3);
});

test('SV2 spinner points and bonus accrue during the spin and use the mod multiplier', () => {
  const samples = Array.from({ length: 43 }, (_, index) => {
    const angle = index * Math.PI / 4;
    return [1000 + 20 * index, 256 + 70 * Math.cos(angle), 192 + 70 * Math.sin(angle), 1];
  });
  const analysis = analyze(['256,192,1000,8,0,2000'], samples, { mods: Mod.ScoreV2 | Mod.Hidden });
  assert.deepEqual(analysis.scoreFrames.map(frame => frame.score), [106, 212, 318, 424, 954, 1_060_954]);
  assert.ok(analysis.scoreFrames.at(-2).time < 2000);
  assert.deepEqual(analysis.comboFrames, [{ time: 2000, combo: 1 }]);
});

test('SV2 gives HR 1.10x, DT and NC 1.20x and NF 1.00x', () => {
  for (const [mods, expectedScore] of [
    [Mod.HardRock, 1_100_000], [Mod.DoubleTime, 1_200_000], [Mod.Nightcore, 1_200_000],
    [Mod.NoFail, 1_000_000], [Mod.HardRock | Mod.Hidden | Mod.Nightcore | Mod.NoFail, 1_399_200],
  ]) {
    const analysis = analyze(['256,192,1000,1,0'], [[1000, 256, 192, 1]], { mods: mods | Mod.ScoreV2 });
    assert.equal(analysis.scoreFrames.at(-1).score, expectedScore);
  }
});

test('lazer ignores the legacy ScoreV2 bit with or without a score info block', () => {
  for (const version of [{ gameVersion: 30000000 }, { scoreInfo: { mods: [{ acronym: 'SV2' }] } }]) {
    const plain = analyze([slider], followSlider(50), { ...version, mods: 0 });
    const flagged = analyze([slider], followSlider(50), version);
    assert.equal(flagged.modDiff.isScoreV2, false);
    assert.deepEqual(flagged.hitResults, plain.hitResults);
    assert.deepEqual(flagged.scoreFrames, plain.scoreFrames);
    assert.deepEqual(flagged.accFrames, plain.accFrames);
  }
});

test('the bundled stable ScoreV1 replay retains its previous analysis', async () => {
  const { replay, beatmap } = await loadReplayPair(
    new URL('../examples/minimal/assets/replay.osr', import.meta.url),
    new URL('../examples/minimal/assets/map.osz', import.meta.url),
  );
  const analysis = analyzeReplay(beatmap, replay);
  assert.equal(analysis.modDiff.isScoreV2, false);
  assert.deepEqual(judgementCounts(analysis), { 300: 424, 100: 4, 50: 0, 0: 1 });
  assert.equal(analysis.scoreFrames.at(-1).maxCombo, 532);
  // Baseline from the fork before adding SV2.
  assert.equal(analysis.scoreFrames.at(-1).score, 6_313_582);
});

const { SV2_REPLAY, SV2_BEATMAP_SET } = process.env;
test('stable SV2 export matches the score, counts, accuracy and combo in its replay header', {
  skip: !SV2_REPLAY && !SV2_BEATMAP_SET && 'Provide SV2_REPLAY and SV2_BEATMAP_SET',
}, async () => {
  assert.ok(SV2_REPLAY && SV2_BEATMAP_SET, 'Both fixture paths are required');
  const { replay, beatmap } = await loadReplayPair(SV2_REPLAY, SV2_BEATMAP_SET);
  const analysis = analyzeReplay(beatmap, replay);
  assert.equal(analysis.mode, 0);
  assert.equal(analysis.modDiff.isScoreV2, true);
  const { count300, count100, count50, countMiss } = replay;
  assert.deepEqual(judgementCounts(analysis), { 300: count300, 100: count100, 50: count50, 0: countMiss });
  assert.equal(analysis.accFrames.at(-1).acc,
    (300 * count300 + 100 * count100 + 50 * count50) / (300 * (count300 + count100 + count50 + countMiss)));
  assert.equal(analysis.scoreFrames.at(-1).maxCombo, replay.maxCombo);
  assert.equal(analysis.scoreFrames.at(-1).score, replay.score);
});
