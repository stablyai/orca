import { describe, expect, it } from 'vitest'
import {
  CALM_STATUS_HEALTHY_HOLD_MS,
  CALM_STATUS_IDLE,
  CALM_STATUS_MIN_VISIBLE_MS,
  CALM_STATUS_REVEAL_DELAY_MS,
  stepCalmStatusReveal,
  type CalmStatusReveal
} from './calm-status-reveal'

function run(
  events: { at: number; down: boolean; immediate?: boolean; since?: number }[]
): boolean[] {
  let state: CalmStatusReveal = CALM_STATUS_IDLE
  return events.map(({ at, down, immediate = false, since }) => {
    const step = stepCalmStatusReveal(state, { down, immediate, now: at, since })
    state = step.next
    return step.visible
  })
}

describe('stepCalmStatusReveal', () => {
  it('keeps a clean reconnect on a 400 ms link silent', () => {
    expect(
      run([
        { at: 0, down: true },
        { at: 4_100, down: true },
        { at: 4_200, down: false },
        { at: 4_200 + CALM_STATUS_HEALTHY_HOLD_MS, down: false }
      ])
    ).toEqual([false, false, false, false])
  })

  it('says an outage that outlasts the delay, and holds it long enough to read', () => {
    const shownAt = CALM_STATUS_REVEAL_DELAY_MS
    const pending = stepCalmStatusReveal(CALM_STATUS_IDLE, {
      down: true,
      immediate: false,
      now: 0
    })
    expect(pending.recheckInMs).toBe(CALM_STATUS_REVEAL_DELAY_MS)
    const shown = stepCalmStatusReveal(pending.next, {
      down: true,
      immediate: false,
      now: shownAt
    })
    const recovering = stepCalmStatusReveal(shown.next, {
      down: false,
      immediate: false,
      now: shownAt + 100
    })
    expect(recovering.recheckInMs).toBe(CALM_STATUS_MIN_VISIBLE_MS - 100)
    expect(
      run([
        { at: 0, down: true },
        { at: shownAt, down: true },
        { at: shownAt + 100, down: false },
        { at: shownAt + CALM_STATUS_MIN_VISIBLE_MS - 1, down: false },
        { at: shownAt + CALM_STATUS_MIN_VISIBLE_MS, down: false }
      ])
    ).toEqual([false, true, true, true, false])
  })

  it('treats a link that answers and drops again inside the hold as one outage', () => {
    const shownAt = CALM_STATUS_REVEAL_DELAY_MS
    expect(
      run([
        { at: 0, down: true },
        { at: shownAt, down: true },
        { at: shownAt + 3_000, down: false },
        { at: shownAt + 3_500, down: true },
        { at: shownAt + 3_600, down: false },
        { at: shownAt + 3_600 + CALM_STATUS_HEALTHY_HOLD_MS, down: false }
      ])
    ).toEqual([false, true, true, true, true, false])
  })

  it('counts a flapping link toward one delay instead of restarting it on every blip', () => {
    expect(
      run([
        { at: 0, down: true },
        { at: 3_000, down: false },
        { at: 3_500, down: true },
        { at: CALM_STATUS_REVEAL_DELAY_MS, down: true }
      ])
    ).toEqual([false, false, false, true])
  })

  it('shows anything needing action at once', () => {
    expect(run([{ at: 0, down: true, immediate: true }])).toEqual([true])
  })

  it('continues an outage clock another surface already started', () => {
    expect(run([{ at: 10_000, down: true, since: 10_000 - CALM_STATUS_REVEAL_DELAY_MS }])).toEqual([
      true
    ])
  })
})
