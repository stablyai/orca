import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudWorkspaceStatus } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import {
  ACTIVITY_REFRESH_MS,
  guardKillFromStatus,
  installCloudActivityRefresh,
  resetGuardKillSeen
} from './cloud-guard-kill-refresh'

const status = (guardKills: number, lastGuardKillAt: number | null): CloudWorkspaceStatus => ({
  state: 'ready',
  metrics: null,
  memory: {
    pressure: 'ok',
    guardKills,
    lastGuardVictim: guardKills ? 'tsc' : null,
    lastGuardKillAt,
    guarded: true
  },
  uptimeMs: 0,
  usage: { totalMs: 0, centsPerHour: 75, costCents: 0 },
  archive: null,
  checkedAt: 1
})

beforeEach(() => resetGuardKillSeen())

describe('guardKillFromStatus', () => {
  it('raises each guard kill once, from whichever read sees it first', () => {
    expect(guardKillFromStatus('ws', status(0, null))).toBeNull()
    expect(guardKillFromStatus('ws', status(1, 1_000), 5)).toEqual({
      workspaceId: 'ws',
      oomKills: 1,
      victim: 'tsc',
      stoppedBy: 'guard',
      at: 5
    })
    expect(guardKillFromStatus('ws', status(1, 1_000))).toBeNull()
    expect(guardKillFromStatus('ws', status(2, 2_000))?.oomKills).toBe(2)
    // Another workspace keeps its own memory.
    expect(guardKillFromStatus('other', status(1, 1_000))).not.toBeNull()
  })
})

describe('installCloudActivityRefresh', () => {
  it('re-reads the active running cloud workspace on focus or typing, throttled', () => {
    const target = new EventTarget()
    let now = 0
    let running = true
    const refresh = vi.fn()
    const dispose = installCloudActivityRefresh({
      activeWorkspaceId: () => 'ws',
      isRunningCloud: () => running,
      refresh,
      target,
      now: () => now
    })
    target.dispatchEvent(new Event('focus'))
    target.dispatchEvent(new Event('keydown'))
    expect(refresh).toHaveBeenCalledTimes(1)
    now = ACTIVITY_REFRESH_MS
    target.dispatchEvent(new Event('keydown'))
    expect(refresh).toHaveBeenCalledTimes(2)
    now = 3 * ACTIVITY_REFRESH_MS
    running = false
    target.dispatchEvent(new Event('focus'))
    expect(refresh).toHaveBeenCalledTimes(2)
    dispose()
    running = true
    target.dispatchEvent(new Event('focus'))
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
