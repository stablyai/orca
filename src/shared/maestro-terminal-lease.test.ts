import { describe, expect, it } from 'vitest'
import {
  canReleaseMaestroTerminalLease,
  canTransitionMaestroTerminalLease
} from './maestro-terminal-lease'

describe('Maestro terminal lease contract', () => {
  it('allows only explicit lifecycle transitions', () => {
    expect(canTransitionMaestroTerminalLease('reserved', 'starting')).toBe(true)
    expect(canTransitionMaestroTerminalLease('active', 'released')).toBe(false)
    expect(canTransitionMaestroTerminalLease('released', 'archived')).toBe(true)
    expect(canTransitionMaestroTerminalLease('active', 'superseded')).toBe(false)
  })

  it('releases workers only after settlement and coordinators only after fencing', () => {
    expect(
      canReleaseMaestroTerminalLease(
        { role: 'worker', lifecycleState: 'settled', coordinatorGeneration: null },
        null
      )
    ).toBe(true)
    expect(
      canReleaseMaestroTerminalLease(
        { role: 'coordinator', lifecycleState: 'retained', coordinatorGeneration: 3 },
        3
      )
    ).toBe(false)
    expect(
      canReleaseMaestroTerminalLease(
        { role: 'coordinator', lifecycleState: 'retained', coordinatorGeneration: 3 },
        4
      )
    ).toBe(true)
  })
})
