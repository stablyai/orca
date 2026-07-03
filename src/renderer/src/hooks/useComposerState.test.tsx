// @vitest-environment happy-dom
import { useEffect } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UseComposerStateResult } from './useComposerState'

const mocks = vi.hoisted(() => ({
  createWorktree: vi.fn(),
  state: {
    repos: [
      {
        id: 'repo-a',
        path: '/repo-a',
        displayName: 'Repo A',
        kind: 'folder',
        connectionId: null
      },
      {
        id: 'repo-b',
        path: '/repo-b',
        displayName: 'Repo B',
        kind: 'folder',
        connectionId: null
      }
    ],
    activeRepoId: 'repo-a',
    projects: [],
    projectGroups: [],
    projectHostSetups: [],
    hosts: [],
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    sshTargetLabels: new Map(),
    workspaceHostScope: null,
    folderWorkspacePathStatuses: {},
    fetchFolderWorkspacePathStatus: vi.fn(),
    getFolderWorkspacePathStatusCacheKey: vi.fn(() => ''),
    getFreshFolderWorkspacePathStatus: vi.fn(() => null),
    settings: {
      defaultTuiAgent: 'claude',
      disabledTuiAgents: [],
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {}
    },
    newWorkspaceDraft: null,
    worktreesByRepo: {},
    sparsePresetsByRepo: {},
    workspaceStatuses: [],
    sshConnectionStates: new Map(),
    sshConnectedGeneration: 0,
    setNewWorkspaceDraft: vi.fn(),
    clearNewWorkspaceDraft: vi.fn(),
    createWorktree: (...args: unknown[]) => mocks.createWorktree(...args),
    updateWorktreeMeta: vi.fn().mockResolvedValue(undefined),
    setSidebarOpen: vi.fn(),
    closeModal: vi.fn(),
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    prefetchWorktreeCreateBase: vi.fn(),
    prefetchWorkItems: vi.fn(),
    fetchSparsePresets: vi.fn().mockResolvedValue(undefined),
    detectedAgentIds: ['claude'],
    remoteDetectedAgentIds: {},
    ensureDetectedAgents: vi.fn().mockResolvedValue(['claude']),
    ensureRemoteDetectedAgents: vi.fn().mockResolvedValue(['claude'])
  }
}))

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: typeof mocks.state) => unknown): unknown =>
    selector(mocks.state)
  useAppStore.getState = () => mocks.state
  return { useAppStore }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/new-workspace-terminal-focus', () => ({
  queueNewWorkspaceTerminalFocus: vi.fn()
}))

vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: vi.fn().mockResolvedValue('skip')
}))

import { useComposerState } from './useComposerState'

function installWindowApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      gh: {
        repoSlug: vi.fn().mockResolvedValue(null),
        listWorkItems: vi.fn().mockResolvedValue({ items: [] }),
        workItem: vi.fn().mockResolvedValue(null),
        workItemByOwnerRepo: vi.fn().mockResolvedValue(null)
      },
      ui: {
        onFileDrop: vi.fn(() => vi.fn())
      },
      shell: {
        pickAttachment: vi.fn().mockResolvedValue(null)
      },
      fs: {
        authorizeExternalPath: vi.fn().mockResolvedValue(undefined),
        stat: vi.fn().mockResolvedValue({ isFile: true, isDirectory: false })
      },
      ssh: {
        connect: vi.fn().mockResolvedValue(undefined)
      },
      worktrees: {
        resolvePrBase: vi.fn().mockResolvedValue(null)
      },
      agentTrust: {
        markTrusted: vi.fn().mockResolvedValue(undefined)
      }
    }
  })
}

function HookHarness({ onResult }: { onResult: (result: UseComposerStateResult) => void }): null {
  const result = useComposerState({
    initialRepoId: 'repo-a',
    initialName: 'workspace-a',
    persistDraft: false,
    enableIssueAutomation: false
  })
  useEffect(() => {
    onResult(result)
  }, [onResult, result])
  return null
}

describe('useComposerState', () => {
  let container: HTMLDivElement
  let root: Root
  let current: UseComposerStateResult | null

  beforeEach(() => {
    installWindowApi()
    mocks.createWorktree.mockReset()
    mocks.createWorktree.mockRejectedValue(new Error('could not resolve a default base ref'))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    current = null
  })

  afterEach(() => {
    if (root) {
      act(() => {
        root.unmount()
      })
    }
    container.remove()
    vi.clearAllMocks()
  })

  it('clears initial-commit recovery state when the repo changes', async () => {
    await act(async () => {
      root.render(<HookHarness onResult={(result) => (current = result)} />)
    })

    await act(async () => {
      await current?.submit()
    })

    expect(current?.cardProps.repoId).toBe('repo-a')
    expect(current?.cardProps.createError?.action).toBe('create-initial-commit')

    await act(async () => {
      current?.cardProps.onRepoChange('repo-b')
    })

    expect(current?.cardProps.repoId).toBe('repo-b')
    expect(current?.cardProps.createError).toBeNull()
  })
})
