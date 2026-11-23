import { describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { createGlobalSettingsFixture } from '../../../../shared/settings/global-settings-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { openNewWorkspaceFromShortcut } from './new-workspace-command'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { Repo } from '../../../../shared/repository/repo-types'

const repo = (id: string): Repo => ({
  id,
  path: `/${id}`,
  displayName: id,
  badgeColor: '#000',
  addedAt: 0,
  kind: 'git',
  executionHostId: 'local'
})

const REPOS = [repo('repo-a'), repo('repo-b')]
const WORKTREE_B = makeWorktree({ id: 'repo-b::/wt', repoId: 'repo-b', hostId: 'local' })
const FOLDER: FolderWorkspace = {
  id: 'folder-1',
  projectGroupId: 'group-1',
  name: 'Folder',
  folderPath: '/folder',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 0,
  updatedAt: 0
}

function shortcutDataFor(
  focused: { workspaceId: string; hostIdentity: string } | null
): Record<string, unknown> {
  const openModal = vi.fn()
  openNewWorkspaceFromShortcut(
    {
      repos: REPOS,
      projectHostSetups: [],
      worktreesByRepo: { 'repo-b': [WORKTREE_B] },
      folderWorkspaces: [FOLDER],
      settings: createGlobalSettingsFixture(),
      activeModal: 'none',
      activeView: 'terminal',
      taskPageData: {},
      openModal
    },
    focused
  )
  return openModal.mock.calls[0]?.[1] ?? {}
}

describe('Create worktree shortcut', () => {
  // The selected row's project seeds the dialog, as the project header's + does (#46995).
  it('opens on the project of the row the sidebar list has focused', () => {
    expect(
      shortcutDataFor({
        workspaceId: 'repo-b::/wt',
        hostIdentity: getWorktreeHostIdentity(WORKTREE_B)
      })
    ).toEqual({ telemetrySource: 'shortcut', initialRepoId: 'repo-b' })
  })

  it('seeds the folder project for a focused folder workspace row', () => {
    expect(
      shortcutDataFor({
        workspaceId: folderWorkspaceKey('folder-1'),
        hostIdentity: 'local|folder:folder-1'
      })
    ).toEqual({ telemetrySource: 'shortcut', initialProjectGroupId: 'group-1' })
  })

  // Focus elsewhere (a terminal, another pane) keeps the composer's active-workspace default.
  it('leaves the target unset while the sidebar list has no focus', () => {
    expect(shortcutDataFor(null)).toEqual({ telemetrySource: 'shortcut' })
  })
})
