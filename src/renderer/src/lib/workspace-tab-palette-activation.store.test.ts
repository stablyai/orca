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
