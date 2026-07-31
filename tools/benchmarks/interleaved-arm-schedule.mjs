/**
 * Launch ordering for interleaved A/B benchmarks.
 *
 * Pair 0 runs baseline-then-candidate, pair 1 candidate-then-baseline, and so
 * on — an ABBA block. Under a drift that grows steadily across the run, the
 * within-pair difference picks up +d on one pair and -d on the next, so the
 * drift cancels out of the averaged deltas instead of being charged to
 * whichever arm happened to run second.
 *
 * The cancellation is exact only when both arms occupy the same mean launch
 * position, which requires an even number of pairs.
 */
export const ARM_NAMES = ['baseline', 'candidate']

export function buildAbbaSchedule(pairCount) {
  const schedule = []
  for (let index = 0; index < pairCount; index++) {
    schedule.push(index % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'])
  }
  return schedule
}

/** Mean launch slot per arm — equal means drift is shared evenly. */
export function meanLaunchPositions(schedule) {
  const positions = { baseline: [], candidate: [] }
  schedule.flat().forEach((arm, slot) => positions[arm].push(slot))
  return Object.fromEntries(
    ARM_NAMES.map((arm) => [
      arm,
      positions[arm].length === 0
        ? null
        : positions[arm].reduce((sum, slot) => sum + slot, 0) / positions[arm].length
    ])
  )
}

export function isCounterbalanced(pairCount) {
  return pairCount > 0 && pairCount % 2 === 0
}
