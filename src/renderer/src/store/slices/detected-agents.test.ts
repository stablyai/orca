import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { Repo, Worktree } from '../../../../shared/types'
import { createDetectedAgentsSlice } from './detected-agents'

const detectAgents = vi.fn()
const refreshAgents = vi.fn()

globalThis.window = {
  api: {
    preflight: {
      detectAgents,
      refreshAgents,
      detectRemoteAgents: vi.fn().mockResolvedValue([])
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
    detectAgents.mockReset().mockResolvedValue(['claude'])
    refreshAgents.mockReset().mockResolvedValue({
      agents: ['codex'],
      addedPathSegments: [],
      shellHydrationOk: true,
      pathSource: 'shell_hydrate',
      pathFailureReason: 'none'
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

    expect(detectAgents).toHaveBeenCalledWith({ wslDistro: 'Ubuntu' })
  })

  it('refreshes local agents inside the active WSL repo distro when no worktree is selected', async () => {
    const store = createTestStore({
      repos: [makeRepo({ id: 'repo-1', path: '\\\\wsl$\\Debian\\home\\alice\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await expect(store.getState().refreshDetectedAgents()).resolves.toEqual(['codex'])

    expect(refreshAgents).toHaveBeenCalledWith({ wslDistro: 'Debian' })
  })

  it('detects local agents in the default WSL distro when the default Windows shell is WSL', async () => {
    const store = createTestStore({
      settings: {
        terminalWindowsShell: 'wsl.exe'
      } as AppState['settings'],
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])

    expect(detectAgents).toHaveBeenCalledWith({ wslDefault: true })
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

    expect(detectAgents).toHaveBeenCalledWith({ wslDistro: 'Debian' })
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

    expect(detectAgents).toHaveBeenCalledWith(undefined)
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

    expect(detectAgents).toHaveBeenCalledWith({ wslDistro: 'Fedora' })
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
