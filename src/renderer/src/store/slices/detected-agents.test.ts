import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { Repo, Worktree } from '../../../../shared/types'
import { createDetectedAgentsSlice } from './detected-agents'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

const detectAgents = vi.fn()
const refreshAgents = vi.fn()
const detectRemoteAgents = vi.fn()

globalThis.window = {
  api: {
    preflight: {
      detectAgents,
      refreshAgents,
      detectRemoteAgents
    },
    platform: {
      get: () => ({ platform: 'win32' })
    }
  } as unknown as Window['api']
} as Window & typeof globalThis

function createTestStore(initial?: Partial<AppState>) {
  const store = create<AppState>()((...a) => createDetectedAgentsSlice(...a) as AppState)
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

  it('detects agents for the requested repo instead of the active repo', async () => {
    const store = createTestStore({
      repos: [
        makeRepo({ id: 'repo-active', path: 'C:\\active' }),
        makeRepo({
          id: 'repo-target',
          path: '\\\\wsl.localhost\\Debian\\home\\alice\\target'
        })
      ],
      activeRepoId: 'repo-active',
      activeWorktreeId: null
    })

    await expect(store.getState().ensureDetectedAgents({ repoId: 'repo-target' })).resolves.toEqual(
      ['claude']
    )

    expect(detectAgents).toHaveBeenCalledWith(
      expect.objectContaining({
        wslDistro: 'Debian',
        projectRuntime: expect.objectContaining({
          runtime: expect.objectContaining({ projectId: 'repo-target', distro: 'Debian' })
        })
      })
    )
  })

  it('does not let an older repository probe replace the newer context cache', async () => {
    let resolveFirst: (ids: string[]) => void = () => {}
    let resolveSecond: (ids: string[]) => void = () => {}
    detectAgents
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          })
      )
    const store = createTestStore({
      repos: [
        makeRepo({ id: 'repo-first', path: 'C:\\first' }),
        makeRepo({ id: 'repo-second', path: 'C:\\second' })
      ]
    })

    const first = store.getState().ensureDetectedAgents({ repoId: 'repo-first' })
    const second = store.getState().ensureDetectedAgents({ repoId: 'repo-second' })
    resolveSecond(['codex'])
    await expect(second).resolves.toEqual(['codex'])
    resolveFirst(['claude'])
    await expect(first).resolves.toEqual(['claude'])

    expect(store.getState().detectedAgentIds).toEqual(['codex'])
  })

  it('does not let a worktree continuation probe replace the composer repository snapshot', async () => {
    let resolveRepo: (ids: string[]) => void = () => {}
    let resolveWorktree: (ids: string[]) => void = () => {}
    detectAgents
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRepo = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveWorktree = resolve
          })
      )
    const worktree = makeWorktree({
      id: 'repo-worktree::worktree',
      repoId: 'repo-worktree',
      path: 'C:\\worktree'
    })
    const store = createTestStore({
      repos: [
        makeRepo({ id: 'repo-composer', path: 'C:\\composer' }),
        makeRepo({ id: 'repo-worktree', path: 'C:\\worktree-repo' })
      ],
      worktreesByRepo: { 'repo-worktree': [worktree] }
    })

    const composer = store.getState().ensureDetectedAgents({ repoId: 'repo-composer' })
    const continuation = store.getState().ensureDetectedAgents({ worktreeId: worktree.id })
    resolveWorktree(['codex'])
    await expect(continuation).resolves.toEqual(['codex'])
    resolveRepo(['claude'])
    await expect(composer).resolves.toEqual(['claude'])

    expect(store.getState().detectedAgentIds).toEqual(['claude'])
  })

  it('does not let an older refresh replace a newer repository detection context', async () => {
    let resolveRefresh: (result: {
      agents: string[]
      addedPathSegments: string[]
      shellHydrationOk: boolean
      pathSource: 'shell_hydrate'
      pathFailureReason: 'none'
    }) => void = () => {}
    refreshAgents.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        })
    )
    detectAgents.mockResolvedValueOnce(['codex'])
    const store = createTestStore({
      repos: [
        makeRepo({ id: 'repo-refresh-source', path: 'C:\\refresh-source' }),
        makeRepo({ id: 'repo-refresh-target', path: 'C:\\refresh-target' })
      ],
      activeRepoId: 'repo-refresh-source',
      activeWorktreeId: null
    })

    const refresh = store.getState().refreshDetectedAgents()
    const newerDetection = store.getState().ensureDetectedAgents({ repoId: 'repo-refresh-target' })
    await expect(newerDetection).resolves.toEqual(['codex'])
    resolveRefresh({
      agents: ['claude'],
      addedPathSegments: [],
      shellHydrationOk: true,
      pathSource: 'shell_hydrate',
      pathFailureReason: 'none'
    })
    await expect(refresh).resolves.toEqual(['claude'])

    expect(store.getState().detectedAgentIds).toEqual(['codex'])
    expect(store.getState().isRefreshingAgents).toBe(false)
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
