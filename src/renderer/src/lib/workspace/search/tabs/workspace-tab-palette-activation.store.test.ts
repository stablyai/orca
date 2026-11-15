// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { Tab } from '../../../../../../shared/tab-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

vi.mock('../../activation/worktree-activation', () => ({
  activateAndRevealWorkspace: () => true
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn(async () => undefined)
}))

import { activateOpenTabSearchResult } from '@/components/tab-bar/open-tab-selection-routing'
import { activateWorkspaceTabPaletteResult } from './workspace-tab-palette-activation'
import {
  getClientHostedBrowserRowSelection,
  selectClientHostedBrowserRow
} from '../../../../runtime/browser/client-hosting/client-hosted-browser-row-state'

const initialState = useAppStore.getInitialState()
afterEach(() => {
  useAppStore.setState(initialState, true)
  document.body.innerHTML = ''
})

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

describe('split terminal focus', () => {
  // Keyed by frame id so cancelAnimationFrame drops superseded focus requests like the browser does.
  let frames = new Map<number, FrameRequestCallback>()
  let nextFrameId = 0

  beforeEach(() => {
    frames = new Map()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++nextFrameId, callback)
      return nextFrameId
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function seedSplitTerminal(): void {
    const terminal: Tab = {
      id: 'unified-terminal',
      entityId: 'terminal',
      groupId: 'group',
      worktreeId: 'wt',
      contentType: 'terminal',
      label: 'Example terminal',
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
        unifiedTabsByWorktree: { wt: [terminal] },
        terminalLayoutsByTabId: {
          terminal: {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: 'left' },
              second: { type: 'leaf', leafId: 'right' }
            },
            activeLeafId: 'right',
            expandedLeafId: null
          }
        }
      },
      true
    )
    document.body.innerHTML = `
      <div data-terminal-tab-id="terminal">
        <div data-leaf-id="left"><textarea class="xterm-helper-textarea"></textarea></div>
        <div data-leaf-id="right"><textarea class="xterm-helper-textarea"></textarea></div>
      </div>`
  }

  function focusedLeafIdAfterFrames(): string | null | undefined {
    // Map iteration visits entries added during the loop, so nested frames run too.
    for (const [id, frame] of frames) {
      frames.delete(id)
      frame(0)
    }
    return document.activeElement?.closest('[data-leaf-id]')?.getAttribute('data-leaf-id')
  }

  it('returns focus to the active pane when Cmd+J picks the tab', () => {
    seedSplitTerminal()

    expect(
      activateWorkspaceTabPaletteResult({
        worktreeId: 'wt',
        groupId: 'group',
        tabId: 'unified-terminal',
        entityId: 'terminal',
        contentType: 'terminal'
      })
    ).toEqual({ status: 'activated' })
    expect(focusedLeafIdAfterFrames()).toBe('right')
  })

  it('returns focus to the active pane when the tab bar switch menu picks the tab', () => {
    seedSplitTerminal()

    const outcome = activateOpenTabSearchResult({
      source: 'workspace',
      executionHostId: 'local',
      id: 'unified-terminal',
      title: 'Example terminal',
      matchedText: null,
      worktreeId: 'wt',
      contentType: 'terminal',
      tabId: 'unified-terminal',
      entityId: 'terminal',
      groupId: 'group',
      relativePath: null,
      occupantAgent: null
    })
    expect(outcome.status).toBe('activated')
    if (outcome.status === 'activated') {
      outcome.focus?.()
    }
    expect(focusedLeafIdAfterFrames()).toBe('right')
  })
})
