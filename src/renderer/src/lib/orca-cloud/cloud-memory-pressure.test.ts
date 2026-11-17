import { describe, expect, it } from 'vitest'
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { cloudMemoryPressure } from './cloud-memory-pressure'

const status = (state: HostedWorkspaceStatus['state']): HostedWorkspaceStatus => ({
  state,
  metrics: null,
  uptimeMs: null,
  usage: { totalMs: 0, centsPerHour: 75, costCents: 0 },
  archive: null,
  checkedAt: 1
})

describe('cloudMemoryPressure', () => {
  it('marks memory pressure only on a ready VM that is short of memory', () => {
    const memory = (pressure: 'ok' | 'high' | 'critical') => ({
      pressure,
      guardKills: 0,
      lastGuardVictim: null,
      lastGuardKillAt: null,
      guarded: true
    })
    expect(cloudMemoryPressure({ ...status('ready'), memory: memory('high') })).toBe('high')
    expect(cloudMemoryPressure({ ...status('ready'), memory: memory('critical') })).toBe('critical')
    expect(cloudMemoryPressure({ ...status('ready'), memory: memory('ok') })).toBeNull()
    // An older control plane says nothing; a sleeping or unresponsive VM shows its own state.
    expect(cloudMemoryPressure(status('ready'))).toBeNull()
    expect(
      cloudMemoryPressure({ ...status('unresponsive'), memory: memory('critical') })
    ).toBeNull()
    expect(cloudMemoryPressure(null)).toBeNull()
  })
})
