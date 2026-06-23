import { describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup, TerminalTab } from '../../../shared/types'
import {
  getActiveTerminalTabIdForUnread,
  markTerminalUnreadForWorktree,
  type TerminalUnreadMarkingStore
} from './terminal-unread-marking'

function terminalTab(id: string, worktreeId = 'wt-1'): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function unifiedTab(
  id: string,
  entityId: string,
  contentType: Tab['contentType'],
  worktreeId = 'wt-1'
): Tab {
  return {
    id,
    entityId,
    groupId: 'group-1',
    worktreeId,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function group(activeTabId: string | null, tabOrder: string[]): TabGroup {
  return {
    id: 'group-1',
    worktreeId: 'wt-1',
    activeTabId,
    tabOrder,
    recentTabIds: tabOrder
  }
}

function store(overrides: Partial<TerminalUnreadMarkingStore> = {}): TerminalUnreadMarkingStore {
  return {
    activeGroupIdByWorktree: {},
    activeTabId: 'term-1',
    activeTabIdByWorktree: { 'wt-1': 'term-1' },
    activeTabType: 'terminal',
    activeTabTypeByWorktree: { 'wt-1': 'terminal' },
    activeWorktreeId: 'wt-1',
    browserTabsByWorktree: {},
    groupsByWorktree: {},
    markTerminalTabUnread: vi.fn(),
    markWorktreeUnread: vi.fn(),
    openFiles: [],
    tabBarOrderByWorktree: { 'wt-1': ['term-1'] },
    tabsByWorktree: { 'wt-1': [terminalTab('term-1')] },
    unifiedTabsByWorktree: {},
    ...overrides
  }
}

describe('terminal unread marking', () => {
  it('marks the active terminal tab and worktree unread', () => {
    const state = store()

    expect(markTerminalUnreadForWorktree(state, 'wt-1')).toBe(true)
    expect(state.markTerminalTabUnread).toHaveBeenCalledWith('term-1')
    expect(state.markWorktreeUnread).toHaveBeenCalledWith('wt-1')
  })

  it('uses the active split-group terminal tab when available', () => {
    const state = store({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: { 'wt-1': [group('unified-term-2', ['unified-term-1', 'unified-term-2'])] },
      tabsByWorktree: { 'wt-1': [terminalTab('term-1'), terminalTab('term-2')] },
      unifiedTabsByWorktree: {
        'wt-1': [
          unifiedTab('unified-term-1', 'term-1', 'terminal'),
          unifiedTab('unified-term-2', 'term-2', 'terminal')
        ]
      }
    })

    expect(getActiveTerminalTabIdForUnread(state, 'wt-1')).toBe('term-2')
  })

  it('does not mark unread when the active split-group tab is not terminal', () => {
    const state = store({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: { 'wt-1': [group('unified-file', ['unified-term', 'unified-file'])] },
      openFiles: [
        {
          id: 'file-1',
          filePath: '/tmp/file.md',
          relativePath: 'file.md',
          worktreeId: 'wt-1',
          language: 'markdown',
          isDirty: false,
          mode: 'edit'
        }
      ],
      unifiedTabsByWorktree: {
        'wt-1': [
          unifiedTab('unified-term', 'term-1', 'terminal'),
          unifiedTab('unified-file', 'file-1', 'editor')
        ]
      }
    })

    expect(markTerminalUnreadForWorktree(state, 'wt-1')).toBe(false)
    expect(state.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(state.markWorktreeUnread).not.toHaveBeenCalled()
  })
})
