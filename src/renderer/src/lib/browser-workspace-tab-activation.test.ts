// @vitest-environment happy-dom

import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { getActivatableBrowserWorkspaceTab } from './browser-workspace-tab-activation'

const initialState = useAppStore.getInitialState()
afterEach(() => useAppStore.setState(initialState, true))

function makeWorktree(overrides: Partial<Worktree> & Pick<Worktree, 'id'>): Worktree {
  return {
    repoId: 'repo',
    path: '/workspace',
    head: '',
    branch: 'main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'Workspace',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const browserTab: Tab = {
  id: 'unified-browser',
  entityId: 'workspace',
  groupId: 'group',
  worktreeId: 'wt',
  contentType: 'browser',
  label: 'Browser',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}

function seedState(worktreesByRepo: Record<string, Worktree[]>, tab: Tab): void {
  useAppStore.setState(
    { ...initialState, worktreesByRepo, unifiedTabsByWorktree: { wt: [tab] } },
    true
  )
}

function makeFolderWorkspace(executionHostId: 'local' | 'ssh:remote'): FolderWorkspace {
  return {
    id: 'shared-folder',
    projectGroupId: 'group',
    name: 'Shared folder',
    folderPath: '/workspace',
    executionHostId,
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
}

it('refuses a hostless browser tab for a remote worktree whose ID also exists locally', () => {
  seedState(
    {
      local: [makeWorktree({ id: 'wt' })],
      remote: [makeWorktree({ id: 'wt', repoId: 'repo-remote', hostId: 'ssh:remote' })]
    },
    browserTab
  )

  expect(
    getActivatableBrowserWorkspaceTab({
      worktreeId: 'wt',
      workspaceId: 'workspace',
      executionHostId: 'ssh:remote'
    })
  ).toBeNull()
})

it('refuses hostless activation when the caller omits a host for an ambiguous worktree id', () => {
  seedState(
    {
      local: [makeWorktree({ id: 'wt' })],
      remote: [makeWorktree({ id: 'wt', repoId: 'repo-remote', hostId: 'ssh:remote' })]
    },
    { ...browserTab, executionHostId: 'ssh:remote' }
  )

  expect(
    getActivatableBrowserWorkspaceTab({ worktreeId: 'wt', workspaceId: 'workspace' })
  ).toBeNull()
})

it('accepts a hostless browser tab when the worktree ID is unambiguous', () => {
  seedState({ remote: [makeWorktree({ id: 'wt', hostId: 'ssh:remote' })] }, browserTab)

  expect(
    getActivatableBrowserWorkspaceTab({
      worktreeId: 'wt',
      workspaceId: 'workspace',
      executionHostId: 'ssh:remote'
    })
  ).toEqual(browserTab)
})

it('includes folder workspaces when rejecting ambiguous hostless activation', () => {
  const worktreeId = folderWorkspaceKey('shared-folder')
  useAppStore.setState(
    {
      ...initialState,
      folderWorkspaces: [makeFolderWorkspace('local'), makeFolderWorkspace('ssh:remote')],
      worktreesByRepo: {},
      unifiedTabsByWorktree: {
        [worktreeId]: [{ ...browserTab, worktreeId, executionHostId: 'ssh:remote' }]
      }
    },
    true
  )

  expect(getActivatableBrowserWorkspaceTab({ worktreeId, workspaceId: 'workspace' })).toBeNull()
})
