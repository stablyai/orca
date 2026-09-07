import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create, type StateCreator } from 'zustand'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import {
  createRemoteServerUpdatesSlice,
  type RemoteServerUpdatesSlice
} from './remote-server-updates'

type TestState = RemoteServerUpdatesSlice & {
  setRuntimeEnvironments: (environments: PublicKnownRuntimeEnvironment[]) => void
}

function environment(id: string): PublicKnownRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: `${id}-ws`, kind: 'websocket', label: 'WebSocket', endpoint: `ws://${id}` }],
    preferredEndpointId: `${id}-ws`
  }
}

function statusResult(id: string, version: string | null, automatic: boolean) {
  const status: RuntimeStatus = {
    runtimeId: `${id}-runtime`,
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    capabilities: automatic ? ['updater.remote-control.v1'] : [],
    ...(version ? { appVersion: version } : {}),
    ...(automatic
      ? {
          remoteUpdateSupport: {
            installMode: 'supervised-headless-serve' as const,
            automatic: true as const,
            reason: 'available' as const
          }
        }
      : {})
  }
  return {
    id: `status-${id}`,
    ok: true,
    result: status,
    _meta: { runtimeId: status.runtimeId }
  } satisfies RuntimeRpcResponse<RuntimeStatus>
}

describe('remote server updates mixed inventory', () => {
  const environments = [
    environment('eligible'),
    environment('current'),
    environment('legacy'),
    environment('offline')
  ]
  const setRuntimeEnvironments = vi.fn()
  const getStatus = vi.fn()
  const call = vi.fn()

  beforeEach(() => {
    setRuntimeEnvironments.mockReset()
    getStatus.mockReset()
    call.mockReset()
    getStatus.mockImplementation(async ({ selector }: { selector: string }) => {
      if (selector === 'offline') {
        throw new Error('connection refused')
      }
      if (selector === 'eligible') {
        return statusResult(selector, '1.4.0', true)
      }
      if (selector === 'current') {
        return statusResult(selector, '1.5.0', true)
      }
      return statusResult(selector, null, false)
    })
    vi.stubGlobal('window', {
      api: {
        updater: { getVersion: vi.fn(async () => '1.5.0') },
        runtimeEnvironments: {
          list: vi.fn(async () => environments),
          getStatus,
          call
        }
      },
      setTimeout
    })
  })

  it('keeps eligible, current, legacy, and offline servers independently actionable', async () => {
    const createSlice = createRemoteServerUpdatesSlice as unknown as StateCreator<TestState>
    const store = create<TestState>()((...args) => ({
      ...createSlice(...args),
      setRuntimeEnvironments
    }))

    await store.getState().refreshRemoteServerUpdates()

    expect(
      Object.fromEntries(
        [...store.getState().remoteServerUpdates].map(([id, entry]) => [id, entry.phase])
      )
    ).toEqual({
      eligible: 'available',
      current: 'current',
      legacy: 'manual',
      offline: 'offline'
    })
    expect(setRuntimeEnvironments).toHaveBeenCalledWith(environments)
    expect(store.getState().remoteServerUpdatesChecking).toBe(false)
  })

  it('keeps settled rows stable while checking again', async () => {
    const createSlice = createRemoteServerUpdatesSlice as unknown as StateCreator<TestState>
    const store = create<TestState>()((...args) => ({
      ...createSlice(...args),
      setRuntimeEnvironments
    }))
    await store.getState().refreshRemoteServerUpdates()

    let releaseChecks!: () => void
    const checksBlocked = new Promise<void>((resolve) => {
      releaseChecks = resolve
    })
    getStatus.mockImplementation(async ({ selector }: { selector: string }) => {
      await checksBlocked
      return statusResult(selector, '1.5.0', true)
    })

    const refresh = store.getState().refreshRemoteServerUpdates()
    await vi.waitFor(() => expect(store.getState().remoteServerUpdatesChecking).toBe(true))

    expect(store.getState().remoteServerUpdates.get('current')).toMatchObject({
      phase: 'current',
      currentVersion: '1.5.0'
    })
    expect(store.getState().remoteServerUpdates.get('eligible')).toMatchObject({
      phase: 'available',
      currentVersion: '1.4.0'
    })

    releaseChecks()
    await refresh
  })

  it('checks and retains the selected perf channel for the update batch', async () => {
    call.mockImplementation(async ({ selector }: { selector: string }) => ({
      id: `check-${selector}`,
      ok: true,
      result: {
        appVersion: '1.5.0',
        runtimeId: `${selector}-runtime`,
        support: {
          installMode: 'supervised-headless-serve' as const,
          automatic: true,
          reason: 'available' as const
        },
        status: { state: 'available' as const, version: '1.6.0-rc.1.perf', changelog: null }
      },
      _meta: { runtimeId: `${selector}-runtime` }
    }))
    const createSlice = createRemoteServerUpdatesSlice as unknown as StateCreator<TestState>
    const store = create<TestState>()((...args) => ({
      ...createSlice(...args),
      setRuntimeEnvironments
    }))
    const options = { includePrerelease: false, includePerfPrerelease: true }

    await store.getState().refreshRemoteServerUpdates(options)

    expect(call).toHaveBeenCalledTimes(2)
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'updater.check', params: options })
    )
    expect(store.getState().remoteServerUpdateCheckOptions).toEqual(options)
    expect(store.getState().remoteServerUpdates.get('current')).toMatchObject({
      phase: 'available',
      targetVersion: '1.6.0-rc.1.perf'
    })

    store.getState().setRemoteServerUpdateDialogOpen(false)
    expect(store.getState().remoteServerUpdateCheckOptions).toBeNull()
  })
})
