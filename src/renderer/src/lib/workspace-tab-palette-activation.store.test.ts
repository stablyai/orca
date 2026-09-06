// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'

vi.mock('./worktree-activation', () => ({ activateAndRevealWorktree: () => true }))

import { activateWorkspaceTabPaletteResult } from './workspace-tab-palette-activation'

const initialState = useAppStore.getInitialState()
afterEach(() => useAppStore.setState(initialState, true))

it('keeps the selected diff active when an editor for the same file shares its group', () => {
  const worktree: Worktree = {
    id: 'wt',
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
    lastActivityAt: 0
  }
  const editor: Tab = {
    id: 'editor',
    entityId: 'file',
    groupId: 'group',
    worktreeId: 'wt',
    contentType: 'editor',
    label: 'app.ts',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  useAppStore.setState(
    {
      ...initialState,
      worktreesByRepo: { repo: [worktree] },
      activeWorktreeId: 'wt',
      groupsByWorktree: {
        wt: [{ id: 'group', worktreeId: 'wt', activeTabId: 'editor', tabOrder: ['editor', 'diff'] }]
      },
      activeGroupIdByWorktree: { wt: 'group' },
      unifiedTabsByWorktree: { wt: [editor, { ...editor, id: 'diff', contentType: 'diff' }] },
      openFiles: [
        {
          id: 'file',
          worktreeId: 'wt',
          filePath: '/workspace/app.ts',
          relativePath: 'app.ts',
          language: 'typescript',
          isDirty: false,
          mode: 'edit'
        }
      ]
    },
    true
  )

  expect(
    activateWorkspaceTabPaletteResult({
      worktreeId: 'wt',
      groupId: 'group',
      tabId: 'diff',
      entityId: 'file',
      contentType: 'diff'
    })
  ).toEqual({ status: 'activated' })
  expect(useAppStore.getState().groupsByWorktree.wt[0].activeTabId).toBe('diff')
  expect(useAppStore.getState().activeFileId).toBe('file')
})

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

const COLLIDING_WORKTREES = {
  local: [makeWorktree({ id: 'wt' })],
  remote: [makeWorktree({ id: 'wt', repoId: 'repo-remote', hostId: 'ssh:remote' })]
}

it('refuses a hostless tab for a remote target whose worktree ID also exists locally', () => {
  const terminal: Tab = {
    id: 'unified-terminal',
    entityId: 'terminal',
    groupId: 'group',
    worktreeId: 'wt',
    contentType: 'terminal',
    label: 'Terminal',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  useAppStore.setState(
    {
      ...initialState,
      worktreesByRepo: COLLIDING_WORKTREES,
      groupsByWorktree: {
        wt: [
          {
            id: 'group',
            worktreeId: 'wt',
            activeTabId: 'unified-terminal',
            tabOrder: ['unified-terminal']
          }
        ]
      },
      activeGroupIdByWorktree: { wt: 'group' },
      unifiedTabsByWorktree: { wt: [terminal] }
    },
    true
  )

  expect(
    activateWorkspaceTabPaletteResult({
      worktreeId: 'wt',
      groupId: 'group',
      tabId: 'unified-terminal',
      entityId: 'terminal',
      contentType: 'terminal',
      executionHostId: 'ssh:remote'
    })
  ).toEqual({ status: 'failed', reason: 'missing-tab' })
})

it('refuses a hostless backing file for a remote target whose worktree ID also exists locally', () => {
  const editor: Tab = {
    id: 'unified-editor',
    entityId: 'file',
    groupId: 'group',
    worktreeId: 'wt',
    contentType: 'editor',
    executionHostId: 'ssh:remote',
    label: 'app.ts',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  useAppStore.setState(
    {
      ...initialState,
      worktreesByRepo: COLLIDING_WORKTREES,
      groupsByWorktree: {
        wt: [
          {
            id: 'group',
            worktreeId: 'wt',
            activeTabId: 'unified-editor',
            tabOrder: ['unified-editor']
          }
        ]
      },
      activeGroupIdByWorktree: { wt: 'group' },
      unifiedTabsByWorktree: { wt: [editor] },
      openFiles: [
        {
          id: 'file',
          worktreeId: 'wt',
          filePath: '/workspace/app.ts',
          relativePath: 'app.ts',
          language: 'typescript',
          isDirty: false,
          mode: 'edit'
        }
      ]
    },
    true
  )

  expect(
    activateWorkspaceTabPaletteResult({
      worktreeId: 'wt',
      groupId: 'group',
      tabId: 'unified-editor',
      entityId: 'file',
      contentType: 'editor',
      executionHostId: 'ssh:remote'
    })
  ).toEqual({ status: 'failed', reason: 'missing-file' })
})
