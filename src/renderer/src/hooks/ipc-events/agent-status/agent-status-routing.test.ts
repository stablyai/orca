import { expect, it } from 'vitest'
import { isSeenHostReplay } from './agent-status-routing'

it('lets a sleep replay carry an unseen clean completion even when it interrupted children', () => {
  const working = { state: 'working', stateStartedAt: 1_000 } as const
  const slept = { isReplay: true, paneSleep: { ptyId: 'pty-1' }, stateStartedAt: 2_000 } as const
  expect(isSeenHostReplay(slept, 'done', working)).toBe(false)
  // Sleep cut only children short: the main agent's own completion is still unseen.
  const finished = { state: 'done', outcome: 'success', stateStartedAt: 1_500 } as const
  expect(
    isSeenHostReplay({ ...slept, interrupted: true, mainAgent: finished }, 'done', working)
  ).toBe(false)
})
