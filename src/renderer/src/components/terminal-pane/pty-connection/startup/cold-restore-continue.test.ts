import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))

describe('shouldContinueInterruptedTurn', () => {
  const now = 1_800_000_000_000
  const working = (stateStartedAt: number) => ({
    state: 'working',
    updatedAt: now - 1000,
    stateStartedAt
  })

  it('continues a remote agent with a fresh working status, once per interrupted turn', async () => {
    const { shouldContinueInterruptedTurn, interruptedTurnKey, markInterruptedTurnContinued } =
      await import('./cold-restore-resume-startup')
    const ctx = { paneKey: 'p1', hasSleepingRecord: false, now }
    expect(shouldContinueInterruptedTurn(working(1), 'env-1', ctx)).toBe(true)
    // Building (and discarding) the startup again does not spend the turn.
    expect(shouldContinueInterruptedTurn(working(1), 'env-1', ctx)).toBe(true)
    // Once the resume launched, a retried cold restore of the same turn does not send it again.
    markInterruptedTurnContinued(interruptedTurnKey(working(1), 'p1'))
    expect(shouldContinueInterruptedTurn(working(1), 'env-1', ctx)).toBe(false)
    // A later interrupted turn does.
    expect(shouldContinueInterruptedTurn(working(2), 'env-1', ctx)).toBe(true)
  })

  it('never continues after a deliberate sleep, for stale or non-working status, or locally', async () => {
    const { shouldContinueInterruptedTurn } = await import('./cold-restore-resume-startup')
    expect(
      shouldContinueInterruptedTurn(working(10), 'env-1', {
        paneKey: 'p2',
        hasSleepingRecord: true,
        now
      })
    ).toBe(false)
    expect(
      shouldContinueInterruptedTurn(
        { state: 'working', updatedAt: now - 31 * 60_000, stateStartedAt: 11 },
        'env-1',
        {
          paneKey: 'p3',
          hasSleepingRecord: false,
          now
        }
      )
    ).toBe(false)
    expect(
      shouldContinueInterruptedTurn(
        { state: 'waiting', updatedAt: now, stateStartedAt: 12 },
        'env-1',
        { paneKey: 'p4', hasSleepingRecord: false, now }
      )
    ).toBe(false)
    expect(
      shouldContinueInterruptedTurn(working(13), null, {
        paneKey: 'p5',
        hasSleepingRecord: false,
        now
      })
    ).toBe(false)
  })
})
