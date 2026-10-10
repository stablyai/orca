import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { codexCliInstallation } from '../../../shared/codex-cli-installation'
import { subscribeCodexMaintenanceHostContact } from './codex-maintenance-host-contact'
import {
  getCodexMaintenanceEntry,
  refreshCodexMaintenance,
  resetCodexMaintenanceStoreForTests
} from './codex-maintenance-store'

const { call, listeners, hostState } = vi.hoisted(() => ({
  call: vi.fn(),
  listeners: new Set<() => void>(),
  hostState: {
    runtimeStatusByEnvironmentId: new Map<
      string,
      { status: RuntimeStatus | null; connectionGeneration: number; hostContactEpoch: number }
    >()
  }
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => hostState,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}))
vi.mock('./codex-maintenance-client', () => ({
  callCodexMaintenance: call,
  codexMaintenanceTargetKey: () => 'runtime:host:codex'
}))
beforeEach(() => {
  resetCodexMaintenanceStoreForTests()
  call.mockReset()
  hostState.runtimeStatusByEnvironmentId.clear()
})
afterEach(() => {
  listeners.clear()
  resetCodexMaintenanceStoreForTests()
})
describe('maintenance host contact lifecycle', () => {
  it('revalidates a paired runtime after contact loss and after a missed outage epoch changes', async () => {
    const target = { kind: 'environment', environmentId: 'host' } as const
    const status: RuntimeStatus = {
      runtimeId: 'host',
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0
    }
    const update = (live: boolean, epoch: number) => {
      hostState.runtimeStatusByEnvironmentId.set('host', {
        status: live ? status : null,
        connectionGeneration: 1,
        hostContactEpoch: epoch
      })
      for (const listener of listeners) {
        listener()
      }
    }
    update(true, 0)
    const unsubscribe = subscribeCodexMaintenanceHostContact(target)
    call.mockResolvedValue({
      installation: codexCliInstallation(true, '0.136.0'),
      evidence: { expiresAt: Date.now() + 30_000, configurationId: 'config' },
      canRun: true,
      job: null
    })
    await refreshCodexMaintenance(target)
    update(false, 0)
    expect(getCodexMaintenanceEntry('runtime:host:codex').verification).toBe('unverifiable')
    update(true, 1)
    await refreshCodexMaintenance(target)
    expect(call).toHaveBeenCalledTimes(2)
    update(true, 2)
    await refreshCodexMaintenance(target)
    expect(call).toHaveBeenCalledTimes(3)
    expect(getCodexMaintenanceEntry('runtime:host:codex').verification).toBe('current')
    unsubscribe()
    expect(listeners.size).toBe(0)
  })
})
