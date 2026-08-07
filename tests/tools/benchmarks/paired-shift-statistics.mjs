/**
 * Paired-shift statistics for interleaved A/B benchmarks.
 *
 * Startup timings on a developer machine drift over the length of a run
 * (thermal throttling, background indexers, page-cache warmth). Comparing the
 * median of five baseline runs against the median of five candidate runs
 * attributes that drift to the change under test. Interleaving the arms turns
 * the comparison into paired samples, and these estimators summarise the pairs
 * without assuming normality — startup distributions are right-skewed and
 * routinely contain a multi-second outlier.
 *
 * Sign convention: a delta is `candidate - baseline`, so a negative shift means
 * the candidate got faster.
 */

/** Median of the finite values, ignoring nulls from phases a run never reached. */
export function median(values) {
  const usable = values
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b)
  if (usable.length === 0) {
    return null
  }
  const mid = Math.floor(usable.length / 2)
  return usable.length % 2 === 1 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2
}

/**
 * Hodges-Lehmann location estimator: the median of all pairwise (Walsh)
 * averages. Preferred over a plain median of deltas because it keeps ~96% of
 * the mean's efficiency on clean data while staying robust to the outlier a
 * single unlucky launch introduces.
 */
export function hodgesLehmannShift(samples) {
  const walshAverages = []
  for (let i = 0; i < samples.length; i++) {
    for (let j = i; j < samples.length; j++) {
      walshAverages.push((samples[i] + samples[j]) / 2)
    }
  }
  return median(walshAverages)
}

// Seeded PRNG: the same samples must always yield the same interval, otherwise
// a re-reported benchmark result cannot be reproduced from its raw JSON.
function createSeededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function quantileOfSorted(sorted, probability) {
  if (sorted.length === 1) {
    return sorted[0]
  }
  const position = probability * (sorted.length - 1)
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) {
    return sorted[lower]
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/**
 * Percentile-bootstrap interval for the Hodges-Lehmann shift. Returns null
 * below two pairs, where resampling cannot say anything useful.
 */
export function bootstrapShiftInterval(samples, options = {}) {
  const { resamples = 2000, level = 0.95, seed = 0x5eed } = options
  if (samples.length < 2) {
    return null
  }
  const random = createSeededRandom(seed)
  const draw = Array.from({ length: samples.length })
  const shifts = []
  for (let round = 0; round < resamples; round++) {
    for (let i = 0; i < samples.length; i++) {
      draw[i] = samples[Math.floor(random() * samples.length)]
    }
    shifts.push(hodgesLehmannShift(draw))
  }
  shifts.sort((a, b) => a - b)
  const tail = (1 - level) / 2
  return [quantileOfSorted(shifts, tail), quantileOfSorted(shifts, 1 - tail)]
}

function classifyInterval(interval) {
  if (!interval) {
    return 'inconclusive'
  }
  const [low, high] = interval
  if (low > 0 && high > 0) {
    return 'regressed'
  }
  if (low < 0 && high < 0) {
    return 'improved'
  }
  return 'inconclusive'
}

/**
 * Summarise one phase's paired deltas. `verdict` is only 'improved' or
 * 'regressed' when the whole interval sits on one side of zero — an interval
 * straddling zero is drift, not a result.
 */
export function summarisePairedShift(deltas, options = {}) {
  const samples = deltas.filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (samples.length === 0) {
    return { pairs: 0, shift: null, interval: null, verdict: 'no-data' }
  }
  const shift = hodgesLehmannShift(samples)
  const interval = bootstrapShiftInterval(samples, options)
  return { pairs: samples.length, shift, interval, verdict: classifyInterval(interval) }
}

/**
 * Deltas for one phase across pairs. A pair contributes nothing unless both
 * arms reached the phase, so a launch that died early cannot bias the shift.
 */
export function pairedDeltas(pairs, phaseName) {
  return pairs.map((pair) => {
    const baseline = pair.baseline?.phases?.[phaseName]
    const candidate = pair.candidate?.phases?.[phaseName]
    if (typeof baseline !== 'number' || typeof candidate !== 'number') {
      return null
    }
    return candidate - baseline
  })
}

const DIRECTIONAL_VERDICTS = new Set(['improved', 'regressed'])

/**
 * Phases the change under test cannot plausibly affect act as a noise floor: if
 * one of them shows a directional shift, the run measured the machine rather
 * than the change, and every other verdict in it is suspect.
 *
 * A control that no launch reached is not evidence of a quiet machine — it is a
 * control that was never measured — so `unmeasured` is reported separately and
 * `measured` is false when nothing usable came back. Only `improved`/`regressed`
 * count as drift; `no-data` is the absence of a measurement, not a direction.
 */
export function detectDrift(phaseSummaries, controlPhaseNames) {
  const controls = controlPhaseNames
    .filter((name) => phaseSummaries[name])
    .map((name) => ({ phase: name, ...phaseSummaries[name] }))
  const drifting = controls.filter((control) => DIRECTIONAL_VERDICTS.has(control.verdict))
  const unmeasured = controlPhaseNames.filter(
    (name) => !phaseSummaries[name] || phaseSummaries[name].verdict === 'no-data'
  )
  return {
    controls,
    drifting,
    unmeasured,
    measured: controls.some((control) => control.verdict !== 'no-data'),
    detected: drifting.length > 0
  }
}
