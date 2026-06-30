import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { Repo, Worktree } from '../../../../shared/types'
import {
  _getRemoteDetectPromiseCountForTest,
  _getRuntimeDetectPromiseCountForTest,
  createDetectedAgentsSlice
} from './detected-agents'
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

function createTestStore(initial?: Partial<AppState>) {
  const store = create<AppState>()(
    (...a) =>
      ({
        ...createDetectedAgentsSlice(...a)
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

function makeWorktree(
  overrides: Partial<Worktree> & { id: string; repoId: string; path: string }
): Worktree {
  return {
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
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

  it('detects local agents inside the active WSL worktree distro', async () => {
    const store = createTestStore({
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({
            id: 'wt-1',
            repoId: 'repo-1',
            path: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
          })
        ]
      },
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1'
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])

    expect(detectAgents).toHaveBeenCalledWith({
      wslDistro: 'Ubuntu',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo-1',
          distro: 'Ubuntu',
          reason: 'project-override',
          cacheKey: 'repo-1:wsl:Ubuntu'
        }
      }
    })
  })

  it('refreshes local agents inside the active WSL repo distro when no worktree is selected', async () => {
    const store = createTestStore({
      repos: [makeRepo({ id: 'repo-1', path: '\\\\wsl$\\Debian\\home\\alice\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await expect(store.getState().refreshDetectedAgents()).resolves.toEqual(['codex'])

    expect(refreshAgents).toHaveBeenCalledWith({
      wslDistro: 'Debian',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo-1',
          distro: 'Debian',
          reason: 'project-override',
          cacheKey: 'repo-1:wsl:Debian'
        }
      }
    })
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

  it('detects local agents in the selected WSL distro when the default Windows shell is WSL', async () => {
    const store = createTestStore({
      settings: {
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian'
      } as AppState['settings'],
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])

    expect(detectAgents).toHaveBeenCalledWith({
      wslDistro: 'Debian',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo-1',
          distro: 'Debian',
          reason: 'global-default',
          cacheKey: 'repo-1:wsl:Debian'
        }
      }
    })
  })

  it('detects Windows agents when explicit agent location is Windows', async () => {
    const store = createTestStore({
      settings: {
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian',
        localAgentRuntime: 'host'
      } as AppState['settings'],
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])

    expect(detectAgents).toHaveBeenCalledWith({
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'windows-host',
          hostPlatform: 'win32',
          projectId: 'repo-1',
          reason: 'global-default',
          cacheKey: 'repo-1:windows-host'
        }
      }
    })
  })

  it('detects WSL agents when explicit agent location is WSL', async () => {
    const store = createTestStore({
      settings: {
        terminalWindowsShell: 'powershell.exe',
        localAgentRuntime: 'wsl',
        localAgentWslDistro: 'Fedora'
      } as AppState['settings'],
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])

    expect(detectAgents).toHaveBeenCalledWith({
      wslDistro: 'Fedora',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo-1',
          distro: 'Fedora',
          reason: 'global-default',
          cacheKey: 'repo-1:wsl:Fedora'
        }
      }
    })
  })

  it('detects agents in the global WSL runtime when no project is active', async () => {
    const store = createTestStore({
      settings: {
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
      } as AppState['settings'],
      activeRepoId: null,
      activeWorktreeId: null
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])

    expect(detectAgents).toHaveBeenCalledWith({
      wslDistro: 'Ubuntu',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'local-project',
          distro: 'Ubuntu',
          reason: 'global-default',
          cacheKey: 'local-project:wsl:Ubuntu'
        }
      }
    })
  })

  it('detects agents in the project override runtime instead of legacy agent location', async () => {
    const store = createTestStore({
      settings: {
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' },
        localAgentRuntime: 'wsl',
        localAgentWslDistro: 'Ubuntu'
      } as AppState['settings'],
      projects: [
        {
          id: 'repo-1',
          sourceRepoIds: ['repo-1'],
          localWindowsRuntimePreference: { kind: 'windows-host' }
        }
      ],
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    } as Partial<AppState>)

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])

    expect(detectAgents).toHaveBeenCalledWith({
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'windows-host',
          hostPlatform: 'win32',
          projectId: 'repo-1',
          reason: 'project-override',
          cacheKey: 'repo-1:windows-host'
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

  it('clears local detection cache explicitly after a project runtime switch', async () => {
    const store = createTestStore({
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])
    expect(store.getState().detectedAgentIds).toEqual(['claude'])

    store.getState().clearLocalDetectedAgents()

    expect(store.getState().detectedAgentIds).toBeNull()
    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])
    expect(detectAgents).toHaveBeenCalledTimes(2)
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
})
