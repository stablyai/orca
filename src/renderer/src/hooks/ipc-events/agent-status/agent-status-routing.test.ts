import { expect, it } from 'vitest'
import { isSeenHostReplay } from './agent-status-routing'

it('lets a sleep replay carry an unseen clean completion but not its own interruption', () => {
  const working = { state: 'working', stateStartedAt: 1_000 } as const
  const slept = { isReplay: true, paneSleep: { ptyId: 'pty-1' }, stateStartedAt: 2_000 } as const
  expect(isSeenHostReplay(slept, 'done', working)).toBe(false)
  expect(isSeenHostReplay({ ...slept, interrupted: true }, 'done', working)).toBe(true)
})
