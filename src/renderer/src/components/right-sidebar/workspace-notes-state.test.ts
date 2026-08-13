import { describe, expect, it } from 'vitest'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { FolderWorkspace, Worktree } from '../../../../shared/types'
import type { AppState } from '../../store/types'
import { selectActiveWorkspaceNote } from './workspace-notes-state'

const WORKTREE_ID = 'repo::/repo/worktree'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: WORKTREE_ID,
    repoId: 'repo',
    displayName: 'Feature branch',
    comment: 'Test the migration',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path: '/repo/worktree',
    head: 'head',
    branch: 'feature/notes',
    isBare: false,
    isMainWorktree: false,
    ...overrides
  }
}

function folderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Docs',
    folderPath: '/docs',
    linkedTask: null,
    comment: 'Review the docs',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    activeWorkspaceKey: null,
    activeWorkspaceExecutionHostId: null,
    activeWorktreeId: null,
    folderWorkspaces: [],
    getKnownWorktreeById: (_worktreeId: string, _executionHostId?: ExecutionHostId) => undefined,
    ...overrides
  } as AppState
}

describe('selectActiveWorkspaceNote', () => {
  it('selects the note for the active worktree workspace', () => {
    const activeWorktree = worktree()

    expect(
      selectActiveWorkspaceNote(
        state({
          activeWorkspaceKey: `worktree:${activeWorktree.id}`,
          getKnownWorktreeById: () => activeWorktree
        })
      )
    ).toEqual({
      scopeKey: 'worktree:repo::/repo/worktree',
      executionHostId: 'local',
      displayName: 'Feature branch',
      branch: 'feature/notes',
      comment: 'Test the migration'
    })
  })

  it('selects the note for the active folder workspace', () => {
    const activeFolder = folderWorkspace()

    expect(
      selectActiveWorkspaceNote(
        state({
          activeWorkspaceKey: `folder:${activeFolder.id}`,
          folderWorkspaces: [activeFolder]
        })
      )
    ).toEqual({
      scopeKey: 'folder:folder-1',
      executionHostId: 'local',
      displayName: 'Docs',
      branch: null,
      comment: 'Review the docs'
    })
  })

  it.each([
    {
      label: 'SSH',
      hostId: toSshExecutionHostId('target-1'),
      folder: folderWorkspace({ connectionId: 'target-1', name: 'SSH docs', comment: 'SSH note' })
    },
    {
      label: 'runtime',
      hostId: toRuntimeExecutionHostId('environment-1'),
      folder: folderWorkspace({
        executionHostId: toRuntimeExecutionHostId('environment-1'),
        name: 'Runtime docs',
        comment: 'Runtime note'
      })
    }
  ])(
    'selects the active $label folder when IDs are duplicated across hosts',
    ({ hostId, folder }) => {
      const localFolder = folderWorkspace({ name: 'Local docs', comment: 'Local note' })

      expect(
        selectActiveWorkspaceNote(
          state({
            activeWorkspaceKey: `folder:${folder.id}`,
            activeWorkspaceExecutionHostId: hostId,
            folderWorkspaces: [localFolder, folder]
          })
        )
      ).toEqual({
        scopeKey: 'folder:folder-1',
        executionHostId: hostId,
        displayName: folder.name,
        branch: null,
        comment: folder.comment
      })
    }
  )

  it('returns no note when the active host owns no matching folder workspace', () => {
    const localFolder = folderWorkspace({ name: 'Local docs', comment: 'Local note' })

    expect(
      selectActiveWorkspaceNote(
        state({
          activeWorkspaceKey: `folder:${localFolder.id}`,
          activeWorkspaceExecutionHostId: toSshExecutionHostId('unmatched-target'),
          folderWorkspaces: [localFolder]
        })
      )
    ).toBeNull()
  })

  it('uses the active host when worktree IDs are duplicated across hosts', () => {
    const localWorktree = worktree({ displayName: 'Local branch', comment: 'Local note' })
    const sshWorktree = worktree({ displayName: 'SSH branch', comment: 'SSH note' })
    const sshHost = toSshExecutionHostId('target-1')

    expect(
      selectActiveWorkspaceNote(
        state({
          activeWorkspaceKey: `worktree:${WORKTREE_ID}`,
          activeWorkspaceExecutionHostId: sshHost,
          getKnownWorktreeById: (_worktreeId, executionHostId) =>
            executionHostId === sshHost ? sshWorktree : localWorktree
        })
      )
    ).toEqual({
      scopeKey: 'worktree:repo::/repo/worktree',
      executionHostId: sshHost,
      displayName: 'SSH branch',
      branch: 'feature/notes',
      comment: 'SSH note'
    })
  })

  it('falls back to the legacy active worktree ID', () => {
    const activeWorktree = worktree()

    expect(
      selectActiveWorkspaceNote(
        state({
          activeWorktreeId: activeWorktree.id,
          getKnownWorktreeById: () => activeWorktree
        })
      )
    ).toEqual({
      scopeKey: 'worktree:repo::/repo/worktree',
      executionHostId: 'local',
      displayName: 'Feature branch',
      branch: 'feature/notes',
      comment: 'Test the migration'
    })
  })

  it('returns null when no workspace is active', () => {
    expect(selectActiveWorkspaceNote(state())).toBeNull()
  })
})
