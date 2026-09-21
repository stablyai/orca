import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Worktree } from '../../../shared/worktree/types'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  folderWorkspaces: [] as FolderWorkspace[],
  worktrees: [] as Worktree[]
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      allWorktrees: () => mocks.worktrees,
      folderWorkspaces: mocks.folderWorkspaces
    })
  }
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace,
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { openLinearIssueWorkspaceOrStart } from './linear-issue-workspace-open'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'worktree-1',
    repoId: 'repo-1',
    path: '/repo/worktree-1',
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Worktree',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: 'ENG-1',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function folderWorkspace(): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Folder workspace',
    folderPath: '/repo/folder-1',
    linkedTask: {
      provider: 'linear',
      type: 'issue',
      number: 1,
      title: 'Issue',
      url: 'https://linear.app/acme/issue/ENG-1/title',
      linearIdentifier: 'ENG-1'
    },
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

describe('openLinearIssueWorkspaceOrStart', () => {
  beforeEach(() => {
    mocks.worktrees = []
    mocks.folderWorkspaces = []
    mocks.activateAndRevealFolderWorkspace.mockReset().mockReturnValue({ primaryTabId: null })
    mocks.activateAndRevealWorktree.mockReset().mockReturnValue({ primaryTabId: null })
  })

  it('qualifies remote worktree activation with its execution host', () => {
    mocks.worktrees = [worktree({ hostId: 'ssh:builder' })]

    expect(openLinearIssueWorkspaceOrStart({ identifier: 'ENG-1' }, vi.fn())).toBe('opened')
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('worktree-1', {
      executionHostId: 'ssh:builder'
    })
  })

  it('opens a linked folder workspace instead of starting a duplicate', () => {
    mocks.folderWorkspaces = [folderWorkspace()]
    const startWorkspace = vi.fn()

    expect(openLinearIssueWorkspaceOrStart({ identifier: 'ENG-1' }, startWorkspace)).toBe('opened')
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-1', {
      executionHostId: 'local'
    })
    expect(startWorkspace).not.toHaveBeenCalled()
  })

  it('starts a workspace when the issue has none attached', () => {
    const startWorkspace = vi.fn()

    expect(openLinearIssueWorkspaceOrStart({ identifier: 'ENG-1' }, startWorkspace)).toBe('started')
    expect(startWorkspace).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('reports failure when activation is refused', () => {
    mocks.worktrees = [worktree()]
    mocks.activateAndRevealWorktree.mockReturnValue(false)
    const startWorkspace = vi.fn()

    expect(openLinearIssueWorkspaceOrStart({ identifier: 'ENG-1' }, startWorkspace)).toBe('failed')
    expect(startWorkspace).not.toHaveBeenCalled()
  })
})
