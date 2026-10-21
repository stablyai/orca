import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MachineExpiryWarning,
  MachineProviderSnapshot
} from '../../../shared/machine-inventory'

const mocks = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/store', async () => {
  const { createTestStore } = await import('./slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { useAppStore } from '@/store'
import {
  applyEnvironmentMachineResult,
  ensureMachinesLoaded,
  loadEnvironmentMachines
} from './machines'

function snapshot(listedAt: number): MachineProviderSnapshot {
  return {
    providerKey: 'plugin:p/omarchy',
    name: 'Omarchy',
    machines: [],
    pendingCreates: [],
    listedAt
  }
}

const ROW = {
  id: 'm',
  name: 'box',
  providerKey: 'plugin:p/omarchy' as const,
  lifetime: 'persistent' as const,
  state: 'running' as const,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: 0
}

const WARNING_KEY = 'plugin:p/omarchy\0m'

function warning(expiresAt: number): MachineExpiryWarning {
  return {
    providerKey: 'plugin:p/omarchy',
    machineId: 'm',
    name: 'box',
    expiresAt,
    workAtRisk: null
  }
}

function rpcError(code: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({ id: '1', ok: false, error: { code, message: code } })
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({ machineProviders: {}, machineEnvironmentProviders: {} })
})

describe('loadEnvironmentMachines', () => {
  it('stores a paired server’s inventory', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, value: [snapshot(1)] })

    await loadEnvironmentMachines('env-1')

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'machines.list',
      {},
      { suppressFeatureInteraction: true }
    )
    expect(useAppStore.getState().machineEnvironmentProviders['env-1']).toEqual([snapshot(1)])
  })

  it('reads an older server without machine methods as having none', async () => {
    mocks.callRuntimeRpc.mockRejectedValue(rpcError('method_not_found'))

    await loadEnvironmentMachines('env-old')

    expect(useAppStore.getState().machineEnvironmentProviders['env-old']).toEqual([])
  })

  it('keeps the last inventory when the server cannot be reached', async () => {
    useAppStore.getState().setMachineEnvironmentSnapshots('env-1', [snapshot(1)])
    mocks.callRuntimeRpc.mockRejectedValueOnce(rpcError('timeout'))
    await loadEnvironmentMachines('env-1')
    mocks.callRuntimeRpc.mockResolvedValueOnce({ ok: false, code: 'failed', message: 'boom' })
    await loadEnvironmentMachines('env-1')

    expect(useAppStore.getState().machineEnvironmentProviders['env-1']).toEqual([snapshot(1)])
  })
})

describe('ensureMachinesLoaded', () => {
  it('keeps a newer push over a late load, retries a failed load, and re-reads on plugin changes', async () => {
    let pushChange: (next: MachineProviderSnapshot) => void = () => {}
    let pluginsChanged: () => void = () => {}
    let pushWarning: (next: MachineExpiryWarning) => void = () => {}
    const snapshots = vi
      .fn()
      .mockRejectedValueOnce(new Error('ipc'))
      .mockResolvedValueOnce({ ok: true, value: [snapshot(1)] })
    vi.stubGlobal('window', {
      api: {
        plugins: {
          onChanged: (callback: () => void) => {
            pluginsChanged = callback
          }
        },
        machines: {
          snapshots,
          onChanged: (callback: (next: MachineProviderSnapshot) => void) => {
            pushChange = callback
          },
          onExpiryWarning: (callback: (next: MachineExpiryWarning) => void) => {
            pushWarning = callback
          },
          expiryWarnings: vi.fn().mockResolvedValue({ ok: true, value: [warning(1)] })
        }
      }
    })

    ensureMachinesLoaded()
    await vi.waitFor(() => expect(snapshots).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    ensureMachinesLoaded()
    pushChange(snapshot(2))
    await vi.waitFor(() => expect(snapshots).toHaveBeenCalledTimes(2))
    await Promise.resolve()

    expect(useAppStore.getState().machineProviders['plugin:p/omarchy']?.listedAt).toBe(2)

    // A provider plugin enabled later appears without a reload; a removed one goes.
    const added = { ...snapshot(5), providerKey: 'plugin:q/docker' as const, name: 'Docker' }
    snapshots.mockResolvedValueOnce({ ok: true, value: [added] })
    pluginsChanged()
    await vi.waitFor(() =>
      expect(Object.keys(useAppStore.getState().machineProviders)).toEqual(['plugin:q/docker'])
    )
    // Main's expiry warnings are read after a reload and follow live pushes, latest per machine.
    expect(window.api.machines.expiryWarnings).toHaveBeenCalled()
    pushChange({ ...snapshot(6), machines: [ROW] })
    pushWarning(warning(1))
    pushWarning(warning(2))
    expect(useAppStore.getState().machineExpiryWarnings[WARNING_KEY]?.expiresAt).toBe(2)
    vi.unstubAllGlobals()
  })
})

describe('machines slice', () => {
  it('keeps the held inventory when a re-list changed nothing', () => {
    useAppStore.getState().applyMachineSnapshot(snapshot(1))
    const held = useAppStore.getState().machineProviders['plugin:p/omarchy']
    useAppStore.getState().applyMachineSnapshot(snapshot(2))
    expect(useAppStore.getState().machineProviders['plugin:p/omarchy']).toBe(held)
    useAppStore.getState().applyMachineSnapshot({ ...snapshot(3), name: 'Renamed' })
    expect(useAppStore.getState().machineProviders['plugin:p/omarchy']?.name).toBe('Renamed')
  })
})

describe('paired-server machines', () => {
  it('asks the server to re-list when refreshing, and ignores a reply it can’t read', async () => {
    useAppStore.getState().setMachineEnvironmentSnapshots('env-1', [snapshot(1)])
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, value: { not: 'a list' } })

    await loadEnvironmentMachines('env-1', { refresh: true })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'machines.list',
      { refresh: true },
      { suppressFeatureInteraction: true }
    )
    expect(useAppStore.getState().machineEnvironmentProviders['env-1']).toEqual([snapshot(1)])
  })

  it('applies the record an action returned, and re-reads the server when there is none', async () => {
    useAppStore
      .getState()
      .setMachineEnvironmentSnapshots('env-1', [{ ...snapshot(1), machines: [ROW] }])

    applyEnvironmentMachineResult('env-1', { ok: true, value: { ...ROW, state: 'sleeping' } })
    expect(
      useAppStore.getState().machineEnvironmentProviders['env-1']?.[0]?.machines[0]?.state
    ).toBe('sleeping')

    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, value: [] })
    applyEnvironmentMachineResult('env-1', { ok: false, code: 'timeout', message: 'slow' })
    await vi.waitFor(() =>
      expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
        expect.anything(),
        'machines.list',
        { refresh: true },
        expect.anything()
      )
    )
  })
})

describe('expiry warnings', () => {
  it('clears a warning once its machine is gone or no longer listed', () => {
    useAppStore.getState().applyMachineSnapshot({ ...snapshot(1), machines: [ROW] })
    useAppStore.getState().applyMachineExpiryWarning(warning(10))
    expect(useAppStore.getState().machineExpiryWarnings[WARNING_KEY]).toBeDefined()

    useAppStore
      .getState()
      .applyMachineSnapshot({ ...snapshot(2), machines: [{ ...ROW, state: 'gone' }] })
    expect(useAppStore.getState().machineExpiryWarnings[WARNING_KEY]).toBeUndefined()
  })
})

describe('paired-server reads overtaken by an action', () => {
  it('drops a list that began before a wake landed and reads the server again', async () => {
    useAppStore
      .getState()
      .setMachineEnvironmentSnapshots('env-1', [
        { ...snapshot(1), machines: [{ ...ROW, state: 'sleeping' }] }
      ])
    let answerStaleList: (value: unknown) => void = () => {}
    mocks.callRuntimeRpc
      .mockReturnValueOnce(new Promise((resolve) => (answerStaleList = resolve)))
      .mockResolvedValueOnce({ ok: true, value: [{ ...snapshot(3), machines: [ROW] }] })

    const reading = loadEnvironmentMachines('env-1')
    applyEnvironmentMachineResult('env-1', { ok: true, value: ROW })
    answerStaleList({
      ok: true,
      value: [{ ...snapshot(2), machines: [{ ...ROW, state: 'sleeping' }] }]
    })
    await reading
    await vi.waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(2))

    await vi.waitFor(() =>
      expect(
        useAppStore.getState().machineEnvironmentProviders['env-1']?.[0]?.machines[0]?.state
      ).toBe('running')
    )
    expect(mocks.callRuntimeRpc).toHaveBeenLastCalledWith(
      expect.anything(),
      'machines.list',
      { refresh: true },
      expect.anything()
    )
  })
})
