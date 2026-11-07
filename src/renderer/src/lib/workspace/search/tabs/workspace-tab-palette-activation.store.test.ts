// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { Tab } from '../../../../../../shared/tab-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

vi.mock('../../activation/worktree-activation', () => ({
  activateAndRevealWorkspace: () => true
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn(async () => undefined)
}))

import { activateWorkspaceTabPaletteResult } from './workspace-tab-palette-activation'
import {
  getClientHostedBrowserRowSelection,
  selectClientHostedBrowserRow
} from '../../../pane-manager/client-hosted-browser-row-state'

const initialState = useAppStore.getInitialState()
afterEach(() => useAppStore.setState(initialState, true))

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

it('keeps the selected diff active when an editor for the same file shares its group', () => {
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

it('shows the selected chat even when a paired-device page placeholder covered it', () => {
  const chat: Tab = {
    id: 'chat',
    entityId: 'session',
    groupId: 'group',
    worktreeId: 'wt',
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    label: 'Claude',
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
        wt: [{ id: 'group', worktreeId: 'wt', activeTabId: 'chat', tabOrder: ['chat'] }]
      },
      activeGroupIdByWorktree: { wt: 'group' },
      unifiedTabsByWorktree: { wt: [chat] }
    },
    true
  )
  selectClientHostedBrowserRow({
    worktreeId: 'wt',
    browserPageId: 'page-on-phone',
    groupId: 'group',
    groupActiveTabIdAtSelection: 'chat'
  })

  expect(
    activateWorkspaceTabPaletteResult({
      worktreeId: 'wt',
      groupId: 'group',
      tabId: 'chat',
      entityId: 'session',
      contentType: 'agent-session'
    })
  ).toEqual({ status: 'activated' })
  expect(getClientHostedBrowserRowSelection()).toBeNull()
  expect(useAppStore.getState().activeTabType).toBe('agent-session')
})
