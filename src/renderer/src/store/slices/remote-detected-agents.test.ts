import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import { _getRemoteDetectPromiseCountForTest, createDetectedAgentsSlice } from './detected-agents'
import {
  _getRuntimeDetectPromiseCountForTest,
  createRuntimeDetectedAgentsSlice
} from './runtime-detected-agents'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

const detectAgents = vi.fn()
const refreshAgents = vi.fn()
const detectRemoteAgents = vi.fn()
const runtimeEnvironmentCall = vi.fn()

globalThis.window = {
  api: {
    preflight: {
      detectAgents,
      refreshAgents,
      detectRemoteAgents
    },
    runtimeEnvironments: {
      call: runtimeEnvironmentCall
    },
    platform: {
      get: () => ({ platform: 'win32' })
    }
  } as unknown as Window['api']
} as Window & typeof globalThis

function createTestStore() {
  const store = create<AppState>()(
    (...a) =>
      ({
        ...createDetectedAgentsSlice(...a),
        ...createRuntimeDetectedAgentsSlice(...a)
      }) as AppState
  )
  store.setState({
    repos: [],
    worktreesByRepo: {},
    activeRepoId: null,
    activeWorktreeId: null
  } as Partial<AppState>)
  return store
}

describe('createDetectedAgentsSlice remote detection', () => {
  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    detectAgents.mockReset().mockResolvedValue(['claude'])
    refreshAgents.mockReset().mockResolvedValue({
      agents: ['codex'],
      addedPathSegments: [],
      shellHydrationOk: true,
      pathSource: 'shell_hydrate',
      pathFailureReason: 'none'
    })
    detectRemoteAgents.mockReset().mockResolvedValue([])
    runtimeEnvironmentCall.mockReset().mockImplementation(({ method }: { method: string }) => {
      const result =
        method === 'status.get'
          ? {
              runtimeId: 'remote-runtime',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
            }
          : ['codex']
      return Promise.resolve({
        id: method,
        ok: true,
        result,
        _meta: { runtimeId: 'remote-runtime' }
      })
    })
  })

  it('retains remote detection promises only while requests are in flight', async () => {
    const store = createTestStore()
    let resolveRemote: (ids: string[]) => void = () => {}
    detectRemoteAgents.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveRemote = resolve
      })
    )

    const first = store.getState().ensureRemoteDetectedAgents('ssh-1')
    const second = store.getState().ensureRemoteDetectedAgents('ssh-1')

    expect(detectRemoteAgents).toHaveBeenCalledTimes(1)
    expect(_getRemoteDetectPromiseCountForTest()).toBe(1)

    resolveRemote(['claude'])

    await expect(first).resolves.toEqual(['claude'])
    await expect(second).resolves.toEqual(['claude'])
    expect(store.getState().remoteDetectedAgentIds['ssh-1']).toEqual(['claude'])
    expect(_getRemoteDetectPromiseCountForTest()).toBe(0)

    await expect(store.getState().ensureRemoteDetectedAgents('ssh-1')).resolves.toEqual(['claude'])
    expect(detectRemoteAgents).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent SSH refreshes', async () => {
    const store = createTestStore()
    store.setState({ remoteDetectedAgentIds: { 'ssh-1': ['claude'] } } as Partial<AppState>)
    let resolveRemote: (ids: string[]) => void = () => {}
    detectRemoteAgents.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveRemote = resolve
      })
    )

    const first = store.getState().refreshRemoteDetectedAgents('ssh-1')
    const second = store.getState().refreshRemoteDetectedAgents('ssh-1')

    expect(second).toBe(first)
    expect(detectRemoteAgents).toHaveBeenCalledTimes(1)
    expect(store.getState().remoteDetectedAgentIds['ssh-1']).toEqual(['claude'])

    resolveRemote(['codex'])
    await expect(first).resolves.toEqual(['codex'])
    expect(store.getState().remoteDetectedAgentIds['ssh-1']).toEqual(['codex'])
  })

  it('does not restore an SSH cache entry after it is cleared mid-detection', async () => {
    const store = createTestStore()
    let resolveRemote: (ids: string[]) => void = () => {}
    detectRemoteAgents.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveRemote = resolve
      })
    )

    const pending = store.getState().ensureRemoteDetectedAgents('ssh-1')
    store.getState().clearRemoteDetectedAgents('ssh-1')
    resolveRemote(['claude'])

    await expect(pending).resolves.toEqual(['claude'])
    expect(store.getState().remoteDetectedAgentIds).not.toHaveProperty('ssh-1')
    expect(store.getState().isDetectingRemoteAgents).not.toHaveProperty('ssh-1')
  })

  it('re-runs remote detection after an empty result instead of pinning it', async () => {
    const store = createTestStore()
    // An empty [] is truthy, so a prior "no agents found" must not be cached:
    // a later install / PATH fix has to be picked up without a reconnect.
    detectRemoteAgents.mockResolvedValueOnce([])

    await expect(store.getState().ensureRemoteDetectedAgents('ssh-1')).resolves.toEqual([])
    expect(store.getState().remoteDetectedAgentIds['ssh-1']).toEqual([])
    expect(detectRemoteAgents).toHaveBeenCalledTimes(1)

    detectRemoteAgents.mockResolvedValueOnce(['kilo'])

    await expect(store.getState().ensureRemoteDetectedAgents('ssh-1')).resolves.toEqual(['kilo'])
    expect(detectRemoteAgents).toHaveBeenCalledTimes(2)
    expect(store.getState().remoteDetectedAgentIds['ssh-1']).toEqual(['kilo'])
  })

  it('detects runtime environment agents through the owning runtime', async () => {
    const store = createTestStore()

    const first = store.getState().ensureRuntimeDetectedAgents('env-1')
    const second = store.getState().ensureRuntimeDetectedAgents('env-1')

    expect(_getRuntimeDetectPromiseCountForTest()).toBe(1)
    await expect(first).resolves.toEqual(['codex'])
    await expect(second).resolves.toEqual(['codex'])
    expect(store.getState().runtimeDetectedAgentIds['env-1']).toEqual(['codex'])
    expect(_getRuntimeDetectPromiseCountForTest()).toBe(0)

    await expect(store.getState().ensureRuntimeDetectedAgents('env-1')).resolves.toEqual(['codex'])
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'status.get',
      params: undefined,
      timeoutMs: undefined
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'preflight.detectAgents',
      params: undefined,
      timeoutMs: undefined
    })
  })

  it('re-runs runtime detection after an empty result instead of pinning it', async () => {
    const store = createTestStore()
    // An empty [] is truthy, so a prior "no agents found" must not be cached:
    // a later install / PATH fix has to be picked up without a reconnect. This is
    // the Orca-serve path (kind: 'runtime'), distinct from the SSH remote path.
    let detectCalls = 0
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      let result: unknown
      if (method === 'status.get') {
        result = {
          runtimeId: 'remote-runtime',
          rendererGraphEpoch: 1,
          graphStatus: 'ready',
          authoritativeWindowId: null,
          liveTabCount: 0,
          liveLeafCount: 0,
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
        }
      } else {
        detectCalls += 1
        result = detectCalls === 1 ? [] : ['kilo']
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result,
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    await expect(store.getState().ensureRuntimeDetectedAgents('env-1')).resolves.toEqual([])
    expect(store.getState().runtimeDetectedAgentIds['env-1']).toEqual([])

    await expect(store.getState().ensureRuntimeDetectedAgents('env-1')).resolves.toEqual(['kilo'])
    expect(store.getState().runtimeDetectedAgentIds['env-1']).toEqual(['kilo'])
    expect(detectCalls).toBe(2)
  })

  it('refreshes runtime agents through preflight.refreshAgents on the owning runtime', async () => {
    const store = createTestStore()
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      let result: unknown
      if (method === 'status.get') {
        result = {
          runtimeId: 'remote-runtime',
          rendererGraphEpoch: 1,
          graphStatus: 'ready',
          authoritativeWindowId: null,
          liveTabCount: 0,
          liveLeafCount: 0,
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
        }
      } else if (method === 'preflight.refreshAgents') {
        result = {
          agents: ['claude', 'gemini'],
          addedPathSegments: [],
          shellHydrationOk: true,
          pathSource: 'shell_hydrate',
          pathFailureReason: 'none'
        }
      } else {
        result = ['codex']
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result,
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    const first = store.getState().refreshRuntimeDetectedAgents('env-1')
    const second = store.getState().refreshRuntimeDetectedAgents('env-1')

    expect(store.getState().isRefreshingRuntimeAgents['env-1']).toBe(true)
    await expect(first).resolves.toEqual(['claude', 'gemini'])
    await expect(second).resolves.toEqual(['claude', 'gemini'])
    expect(store.getState().runtimeDetectedAgentIds['env-1']).toEqual(['claude', 'gemini'])
    expect(store.getState().isRefreshingRuntimeAgents['env-1']).toBe(false)
    expect(
      runtimeEnvironmentCall.mock.calls.filter(
        ([{ method }]) => method === 'preflight.refreshAgents'
      )
    ).toHaveLength(1)
  })

  it('keeps a late initial detect from overwriting a runtime refresh', async () => {
    const store = createTestStore()
    let resolveDetect: (value: unknown) => void = () => {}
    let resolveRefresh: (value: unknown) => void = () => {}
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      if (method === 'status.get') {
        return Promise.resolve({
          id: method,
          ok: true,
          result: {
            runtimeId: 'remote-runtime',
            rendererGraphEpoch: 1,
            graphStatus: 'ready',
            authoritativeWindowId: null,
            liveTabCount: 0,
            liveLeafCount: 0,
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
          },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return new Promise((resolve) => {
        if (method === 'preflight.detectAgents') {
          resolveDetect = resolve
        } else {
          resolveRefresh = resolve
        }
      })
    })

    const detect = store.getState().ensureRuntimeDetectedAgents('env-1')
    await vi.waitFor(() => {
      expect(
        runtimeEnvironmentCall.mock.calls.filter(
          ([{ method }]) => method === 'preflight.detectAgents'
        )
      ).toHaveLength(1)
    })

    const refresh = store.getState().refreshRuntimeDetectedAgents('env-1')
    expect(store.getState().ensureRuntimeDetectedAgents('env-1')).toBe(refresh)
    expect(store.getState().isDetectingRuntimeAgents['env-1']).toBe(true)
    expect(store.getState().isRefreshingRuntimeAgents['env-1']).toBe(true)
    await vi.waitFor(() => {
      expect(
        runtimeEnvironmentCall.mock.calls.filter(
          ([{ method }]) => method === 'preflight.refreshAgents'
        )
      ).toHaveLength(1)
    })
    resolveRefresh({
      id: 'preflight.refreshAgents',
      ok: true,
      result: {
        agents: ['kilo'],
        addedPathSegments: [],
        shellHydrationOk: true,
        pathSource: 'shell_hydrate',
        pathFailureReason: 'none'
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    await expect(refresh).resolves.toEqual(['kilo'])

    resolveDetect({
      id: 'preflight.detectAgents',
      ok: true,
      result: ['claude'],
      _meta: { runtimeId: 'remote-runtime' }
    })
    await expect(detect).resolves.toEqual(['claude'])

    expect(store.getState().runtimeDetectedAgentIds['env-1']).toEqual(['kilo'])
    expect(store.getState().isDetectingRuntimeAgents['env-1']).toBe(false)
    expect(store.getState().isRefreshingRuntimeAgents['env-1']).toBe(false)
    expect(
      runtimeEnvironmentCall.mock.calls.filter(
        ([{ method }]) => method === 'preflight.refreshAgents'
      )
    ).toHaveLength(1)
  })

  it('falls back to plain runtime re-detection when the server lacks preflight.refreshAgents', async () => {
    const store = createTestStore()
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      if (method === 'preflight.refreshAgents') {
        return Promise.resolve({
          id: method,
          ok: false,
          error: { code: 'method_not_found', message: `Unknown method: ${method}` },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      const result =
        method === 'status.get'
          ? {
              runtimeId: 'remote-runtime',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
            }
          : ['kilo']
      return Promise.resolve({
        id: method,
        ok: true,
        result,
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    await expect(store.getState().refreshRuntimeDetectedAgents('env-1')).resolves.toEqual(['kilo'])
    expect(store.getState().runtimeDetectedAgentIds['env-1']).toEqual(['kilo'])
    expect(store.getState().isRefreshingRuntimeAgents['env-1']).toBe(false)
  })

  it('does not retry ordinary runtime refresh failures with a second RPC', async () => {
    const store = createTestStore()
    store.setState({ runtimeDetectedAgentIds: { 'env-1': ['claude'] } } as Partial<AppState>)
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      if (method === 'status.get') {
        return Promise.resolve({
          id: method,
          ok: true,
          result: {
            runtimeId: 'remote-runtime',
            rendererGraphEpoch: 1,
            graphStatus: 'ready',
            authoritativeWindowId: null,
            liveTabCount: 0,
            liveLeafCount: 0,
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
          },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      if (method === 'preflight.refreshAgents') {
        return Promise.resolve({
          id: method,
          ok: false,
          error: { code: 'runtime_error', message: 'runtime disconnected' },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result: ['codex'],
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    await expect(store.getState().refreshRuntimeDetectedAgents('env-1')).resolves.toEqual([
      'claude'
    ])
    expect(store.getState().runtimeDetectedAgentIds['env-1']).toEqual(['claude'])
    expect(store.getState().isRefreshingRuntimeAgents['env-1']).toBe(false)
    expect(
      runtimeEnvironmentCall.mock.calls.filter(([{ method }]) => method.startsWith('preflight.'))
    ).toHaveLength(1)
  })
})
