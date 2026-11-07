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
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'

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

  it('publishes a Floating-first host probe to a later ordinary local caller', async () => {
    let resolveDetection: (agents: string[]) => void = () => {}
    detectAgents.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveDetection = resolve
      })
    )
    const store = createTestStore()

    const floating = store.getState().ensureDetectedAgents(FLOATING_TERMINAL_WORKTREE_ID)
    const ordinary = store.getState().ensureDetectedAgents()

    expect(detectAgents).toHaveBeenCalledTimes(1)
    expect(store.getState().isDetectingAgents).toBe(true)
    resolveDetection(['codex'])
    await expect(Promise.all([floating, ordinary])).resolves.toEqual([['codex'], ['codex']])
    expect(store.getState().detectedAgentIds).toEqual(['codex'])
    expect(store.getState().isDetectingAgents).toBe(false)
  })

  it('restores the legacy inventory when returning to a cached local context', async () => {
    detectAgents.mockImplementation(async (context) =>
      context?.projectRuntime?.runtime.kind === 'wsl' ? ['claude'] : ['codex']
    )
    const store = createTestStore({
      repos: [makeRepo({ id: 'repo-1', path: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await store.getState().ensureDetectedAgents()
    store.setState({ activeRepoId: null })
    await store.getState().ensureDetectedAgents()
    store.setState({ activeRepoId: 'repo-1' })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])
    expect(store.getState().detectedAgentIds).toEqual(['claude'])
  })

  it('retries a local context after a transient detection failure', async () => {
    detectAgents
      .mockRejectedValueOnce(new Error('cold-start timeout'))
      .mockResolvedValueOnce(['codex'])
    const store = createTestStore()

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual([])
    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['codex'])

    expect(store.getState().detectedAgentIds).toEqual(['codex'])
  })

  it('clears local agents when the project runtime requires repair before detection', async () => {
    detectAgents.mockImplementation(async (context) => {
      if (context?.projectRuntime?.status === 'repair-required') {
        throw new Error('Project runtime requires repair before agent detection')
      }
      return ['claude']
    })
    const store = createTestStore({
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])
    expect(store.getState().detectedAgentIds).toEqual(['claude'])

    store.setState({
      settings: {
        terminalWindowsShell: 'wsl.exe'
      } as AppState['settings']
    } as Partial<AppState>)

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual([])
    expect(store.getState().detectedAgentIds).toEqual([])

    expect(detectAgents).toHaveBeenCalledWith({
      enabledOnly: true,
      projectRuntime: {
        status: 'repair-required',
        repair: {
          projectId: 'repo-1',
          preferredRuntime: { kind: 'wsl', distro: null },
          reason: 'wsl-distro-required',
          source: 'global-default',
          cacheKey: 'repo-1:repair:wsl-distro-required:default'
        }
      }
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

  it('ignores in-flight local detection results after a project runtime switch', async () => {
    let resolveDetection: (agents: string[]) => void = () => {}
    detectAgents.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveDetection = resolve
      })
    )
    const store = createTestStore({
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    const pending = store.getState().ensureDetectedAgents()
    store.getState().clearLocalDetectedAgents()
    resolveDetection(['claude'])

    await expect(pending).resolves.toEqual(['claude'])
    expect(store.getState().detectedAgentIds).toBeNull()
    expect(store.getState().isDetectingAgents).toBe(false)
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

  it('shares an in-flight SSH detection and publishes its settled inventory', async () => {
    const store = createTestStore()
    let resolveRemote: (ids: string[]) => void = () => {}
    detectRemoteAgents.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveRemote = resolve
      })
    )

    const first = store.getState().ensureRemoteDetectedAgents('ssh-1')
    const second = store.getState().ensureRemoteDetectedAgents('ssh-1')

    expect(second).toBe(first)

    resolveRemote(['claude'])

    await expect(first).resolves.toEqual(['claude'])
    await expect(second).resolves.toEqual(['claude'])
    expect(store.getState().remoteDetectedAgentIds['ssh-1']).toEqual(['claude'])

    await expect(store.getState().ensureRemoteDetectedAgents('ssh-1')).resolves.toEqual(['claude'])
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
    // Retry empty detections so later installs/PATH fixes appear without reconnect; [] truthiness must not cache misses.
    detectRemoteAgents.mockResolvedValueOnce([])

    await expect(store.getState().ensureRemoteDetectedAgents('ssh-1')).resolves.toEqual([])
    expect(store.getState().remoteDetectedAgentIds['ssh-1']).toEqual([])

    detectRemoteAgents.mockResolvedValueOnce(['kilo'])

    await expect(store.getState().ensureRemoteDetectedAgents('ssh-1')).resolves.toEqual(['kilo'])
    expect(store.getState().remoteDetectedAgentIds['ssh-1']).toEqual(['kilo'])
  })

  it('re-runs runtime detection after an empty result instead of pinning it', async () => {
    const store = createTestStore()
    // Runtime Orca-serve path must retry empty detection after install/PATH fixes too, independently of SSH.
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
