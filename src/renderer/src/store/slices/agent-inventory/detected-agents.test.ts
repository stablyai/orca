import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../../types'
import type { Repo } from '../../../../../shared/repo-types'

import { createDetectedAgentsSlice } from './create-detected-agents-slice'
import { createRuntimeDetectedAgentsSlice } from './runtime-detected-agents'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../../shared/protocol-version'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'

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

function createTestStore(initial?: Partial<AppState>) {
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
    activeWorktreeId: null,
    ...initial
  } as Partial<AppState>)
  return store
}

function makeRepo(overrides: Partial<Repo> & { id: string; path: string }): Repo {
  return {
    displayName: 'Repo',
    badgeColor: '#000000',
    addedAt: 0,
    ...overrides
  }
}

describe('createDetectedAgentsSlice WSL context', () => {
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
    runtimeEnvironmentCall.mockReset().mockResolvedValue({
      id: 'default',
      ok: true,
      result: [],
      _meta: { runtimeId: 'runtime' }
    })
  })

  it('does not keep previous context agents when detection fails after a context switch', async () => {
    detectAgents
      .mockReset()
      .mockResolvedValueOnce(['claude'])
      .mockRejectedValueOnce(new Error('probe failed'))
    const store = createTestStore({
      repos: [makeRepo({ id: 'repo-1', path: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])
    expect(store.getState().detectedAgentIds).toEqual(['claude'])

    store.setState({
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    } as Partial<AppState>)
    const detected = store.getState().ensureDetectedAgents()

    expect(store.getState().detectedAgentIds).toBeNull()
    await expect(detected).resolves.toEqual([])
    expect(store.getState().detectedAgentIds).toEqual([])
  })
})

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
    // Retry empty detections so later installs/PATH fixes appear without reconnect; [] truthiness must not cache misses.
    detectRemoteAgents.mockResolvedValueOnce([])

    await expect(store.getState().ensureRemoteDetectedAgents('ssh-1')).resolves.toEqual([])
    expect(store.getState().remoteDetectedAgentIds['ssh-1']).toEqual([])

    detectRemoteAgents.mockResolvedValueOnce(['kilo'])

    await expect(store.getState().ensureRemoteDetectedAgents('ssh-1')).resolves.toEqual(['kilo'])
    expect(store.getState().remoteDetectedAgentIds['ssh-1']).toEqual(['kilo'])
  })

  it.each([false, true])(
    'follows an automatic host refresh with one explicit request (automatic fails: %s)',
    async (fails) => {
      const store = createTestStore()
      const automaticReply = Promise.withResolvers<unknown>()
      runtimeEnvironmentCall.mockImplementation(
        ({ method, params }: { method: string; params?: { userInitiated?: boolean } }) => {
          if (method === 'preflight.refreshAgents') {
            return params?.userInitiated
              ? Promise.resolve({ id: method, ok: true, result: { agents: ['grok'] } })
              : automaticReply.promise
          }
          return Promise.resolve({
            id: method,
            ok: true,
            result: {
              runtimeId: 'runtime',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
            }
          })
        }
      )
      const automatic = store.getState().refreshRuntimeDetectedAgents('env-explicit')
      const explicit = store
        .getState()
        .refreshRuntimeDetectedAgents('env-explicit', undefined, { userInitiated: true })
      expect(
        store
          .getState()
          .refreshRuntimeDetectedAgents('env-explicit', undefined, { userInitiated: true })
      ).toBe(explicit)
      if (fails) {
        automaticReply.reject(new Error('host temporarily unavailable'))
      } else {
        automaticReply.resolve({
          id: 'preflight.refreshAgents',
          ok: true,
          result: { agents: ['claude'] }
        })
      }
      await automatic
      expect(await explicit).toEqual(['grok'])
      expect(store.getState().runtimeDetectedAgentIds['env-explicit']).toEqual(['grok'])
    }
  )

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
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'preflight.detectAgents' })
      )
    })

    const refresh = store.getState().refreshRuntimeDetectedAgents('env-1')
    expect(store.getState().ensureRuntimeDetectedAgents('env-1')).toBe(refresh)
    expect(store.getState().isDetectingRuntimeAgents['env-1']).toBe(true)
    expect(store.getState().isRefreshingRuntimeAgents['env-1']).toBe(true)
    await vi.waitFor(() => {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'preflight.refreshAgents' })
      )
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
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'preflight.detectAgents' })
    )
  })
})
