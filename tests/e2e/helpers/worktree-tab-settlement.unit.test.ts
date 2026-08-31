import { describe, expect, it } from 'vitest'
import {
  createWorktreeTabSettleTracker,
  toWorktreeTabObservation,
  worktreeTabObservationKey,
  type WorktreeTabObservation
} from './worktree-tab-settlement'

/** The settle loop calls the tracker once per poll and stops at three agreements. */
const AGREEMENTS_TO_SETTLE = 3

const ABSENT: WorktreeTabObservation = { present: false }
const EMPTY: WorktreeTabObservation = { present: true, tabIds: [] }
const THREE: WorktreeTabObservation = { present: true, tabIds: ['a', 'b', 'c'] }

function agreementsFor(
  observations: WorktreeTabObservation[],
  requirePresentRow: boolean
): number[] {
  const tracker = createWorktreeTabSettleTracker({ requirePresentRow })
  return observations.map((observation) => tracker.observe(observation))
}

describe('worktree tab observations', () => {
  it('does not turn a missing row into an empty one', () => {
    expect(toWorktreeTabObservation(null)).toEqual({ present: false })
    expect(toWorktreeTabObservation([])).toEqual({ present: true, tabIds: [] })
  })

  it('keys a missing row apart from a row holding no tabs', () => {
    expect(worktreeTabObservationKey(ABSENT)).not.toBe(worktreeTabObservationKey(EMPTY))
  })

  it('gives every observation a non-empty key, so no seed value can collide with one', () => {
    for (const observation of [ABSENT, EMPTY, THREE]) {
      expect(worktreeTabObservationKey(observation)).not.toBe('')
    }
  })
})

describe('worktree tab settle tracker', () => {
  it('never settles on a missing row when the row is required', () => {
    // Four polls of nothing. The old helper answered "zero tabs" after three of these.
    expect(agreementsFor([ABSENT, ABSENT, ABSENT, ABSENT], true)).toEqual([0, 0, 0, 0])
  })

  it('settles on a row that holds no tabs when a missing row is a legitimate rest', () => {
    expect(agreementsFor([ABSENT, ABSENT, ABSENT, ABSENT], false)).toEqual([0, 1, 2, 3])
  })

  it('charges the first poll nothing, so three agreements mean three agreeing polls', () => {
    // The seed used to be '', which is what an empty tab list serialised to — so an empty
    // workspace was handed one agreement for free and settled a whole poll early.
    const [first] = agreementsFor([EMPTY, EMPTY, EMPTY, EMPTY], true)
    expect(first).toBe(0)
    expect(agreementsFor([EMPTY, EMPTY, EMPTY, EMPTY], true)).toEqual([0, 1, 2, 3])
  })

  it('treats a row appearing as a change, not as more of the same', () => {
    // Collapse absent into empty and this reads as four agreeing polls of "no tabs".
    expect(agreementsFor([ABSENT, EMPTY, EMPTY, EMPTY], false)).toEqual([0, 0, 1, 2])
  })

  it('needs the same three agreements once the row is populated', () => {
    const agreements = agreementsFor([ABSENT, THREE, THREE, THREE, THREE], true)
    expect(agreements).toEqual([0, 0, 1, 2, 3])
    expect(agreements.filter((count) => count >= AGREEMENTS_TO_SETTLE)).toHaveLength(1)
  })

  it('reports the observation it settled on', () => {
    const tracker = createWorktreeTabSettleTracker({ requirePresentRow: true })
    tracker.observe(ABSENT)
    expect(tracker.latest()).toEqual(ABSENT)
    tracker.observe(THREE)
    expect(tracker.latest()).toEqual(THREE)
  })
})
