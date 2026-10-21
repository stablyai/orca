import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineProviderSnapshot } from '../../../shared/machine-inventory'

const mocks = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/store', async () => {
  const { createTestStore } = await import('./slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { useAppStore } from '@/store'
import { ensureMachinesLoaded, loadEnvironmentMachines } from './machines'

function snapshot(listedAt: number): MachineProviderSnapshot {
  return {
    providerKey: 'plugin:p/omarchy',
    name: 'Omarchy',
    machines: [],
    pendingCreates: [],
    listedAt
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
          }
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
