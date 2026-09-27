import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as UnreadBadgeCountModule from './unread-badge-count'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { AppState } from '@/store/types'
import {
  resetFloatingWorkspaceUnreadSelectorCacheForTest,
  selectFloatingWorkspaceHasUnread
} from '@/store/selectors'
import {
  makeFolderWorkspace,
  makeTerminalTab,
  makeWorktree
} from '@/store/slices/worktrees-slice-test-fixtures'

const { getUnreadBadgeCount } = vi.hoisted(() => ({ getUnreadBadgeCount: vi.fn() }))

vi.mock('./unread-badge-count', async (importOriginal) => {
  const actual = await importOriginal<typeof UnreadBadgeCountModule>()
  getUnreadBadgeCount.mockImplementation(actual.getUnreadBadgeCount)
  return { ...actual, getUnreadBadgeCount }
})

import {
  createUnreadBadgeCountSelector,
  type UnreadBadgeCountState
} from './unread-badge-count-selector'

type BadgeTestState = UnreadBadgeCountState &
  Pick<AppState, 'tabsByWorktree' | 'unreadTerminalTabs' | 'unreadAgentCompletionPanes'> & {
    /** Stands in for sidebar view state and connection liveness, which the badge must ignore. */
    unrelated: number
  }

const WT = 'repo::wt-1'
const FLOATING_TAB = 'floating-tab'

function makeState(overrides: Partial<BadgeTestState> = {}): BadgeTestState {
  return {
    worktreesByRepo: { repo: [makeWorktree({ id: WT, repoId: 'repo' })] },
    folderWorkspaces: [makeFolderWorkspace({ id: 'f-1' })],
    settings: { floatingTerminalEnabled: true },
    tabsByWorktree: {
      [WT]: [makeTerminalTab({ id: 'tab-1', worktreeId: WT })],
      [FLOATING_TERMINAL_WORKTREE_ID]: [
        makeTerminalTab({ id: FLOATING_TAB, worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
      ]
    },
    unreadTerminalTabs: {},
    unreadAgentCompletionPanes: {},
    unrelated: 0,
    ...overrides
  }
}

function withWorktree(
  state: BadgeTestState,
  isUnread: boolean,
  isArchived = false
): BadgeTestState {
  return {
    ...state,
    worktreesByRepo: { repo: [makeWorktree({ id: WT, repoId: 'repo', isUnread, isArchived })] }
  }
}

describe('createUnreadBadgeCountSelector', () => {
  let select: (state: BadgeTestState) => number

  beforeEach(() => {
    getUnreadBadgeCount.mockClear()
    resetFloatingWorkspaceUnreadSelectorCacheForTest()
    select = createUnreadBadgeCountSelector<BadgeTestState>(selectFloatingWorkspaceHasUnread)
  })

  it('recounts when a worktree unread or archived flag moves', () => {
    let state = makeState()
    expect(select(state)).toBe(0)
    state = withWorktree(state, true)
    expect(select(state)).toBe(1)
    state = withWorktree(state, true, true)
    expect(select(state)).toBe(0)
    state = withWorktree(state, true, false)
    expect(select(state)).toBe(1)
    expect(getUnreadBadgeCount).toHaveBeenCalledTimes(4)
  })

  it('recounts when a folder unread or archived flag moves, and not on other folder edits', () => {
    let state = makeState()
    select(state)
    state = { ...state, folderWorkspaces: [makeFolderWorkspace({ id: 'f-1', isUnread: true })] }
    expect(select(state)).toBe(1)
    state = {
      ...state,
      folderWorkspaces: [makeFolderWorkspace({ id: 'f-1', isUnread: true, name: 'renamed' })]
    }
    expect(select(state)).toBe(1)
    expect(getUnreadBadgeCount).toHaveBeenCalledTimes(2)
    state = {
      ...state,
      folderWorkspaces: [makeFolderWorkspace({ id: 'f-1', isUnread: true, isArchived: true })]
    }
    expect(select(state)).toBe(0)
    expect(getUnreadBadgeCount).toHaveBeenCalledTimes(3)
    state = { ...state, folderWorkspaces: [makeFolderWorkspace({ id: 'f-1', isUnread: true })] }
    expect(select(state)).toBe(1)
    state = { ...state, folderWorkspaces: [] }
    expect(select(state)).toBe(0)
  })

  it('counts folders sharing one workspace key once', () => {
    const state = makeState({
      folderWorkspaces: [
        makeFolderWorkspace({ id: 'f-1', isUnread: true, executionHostId: 'local' }),
        makeFolderWorkspace({ id: 'f-1', isUnread: true, executionHostId: 'ssh:ssh-1' })
      ]
    })

    expect(select(state)).toBe(1)
  })

  // Behaviour change: tab-only unread used to count by owning worktree. The badge now follows the
  // workspace flag the sidebar shows, so markers without a flag — live siblings, retired tabs, or
  // agent-session ids — neither count nor wake a recount.
  it('does not count or recount for non-floating tab markers', () => {
    const state = makeState()
    expect(select(state)).toBe(0)
    expect(
      select({
        ...state,
        unreadTerminalTabs: {
          'tab-1': 'terminal-bell',
          'retired-tab': true,
          'structured-agent-session-s1': true
        },
        unreadAgentCompletionPanes: { 'tab-1:leaf-1': true }
      })
    ).toBe(0)
    expect(getUnreadBadgeCount).toHaveBeenCalledTimes(1)
  })

  it('keeps a flagged workspace at one when stale markers sit beside it', () => {
    const state = withWorktree(makeState(), true)
    expect(
      select({
        ...state,
        unreadTerminalTabs: { 'retired-tab': true, 'structured-agent-session-s1': true }
      })
    ).toBe(1)
  })

  it('does not recount on title frames, tab activations, or unrelated writes', () => {
    const state = withWorktree(makeState(), true)
    select(state)
    const retitled = {
      ...state,
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [WT]: [makeTerminalTab({ id: 'tab-1', worktreeId: WT, title: 'agent frame' })]
      },
      worktreesByRepo: {
        repo: [makeWorktree({ id: WT, repoId: 'repo', isUnread: true, lastActivityAt: 99 })]
      }
    }
    expect(select(retitled)).toBe(1)
    expect(select({ ...retitled, unrelated: 1 })).toBe(1)
    expect(getUnreadBadgeCount).toHaveBeenCalledTimes(1)
  })

  it('counts floating bells and completions once, and drops stale floating keys', () => {
    let state = makeState()
    expect(select(state)).toBe(0)
    state = { ...state, unreadTerminalTabs: { [FLOATING_TAB]: 'terminal-bell' } }
    expect(select(state)).toBe(1)
    state = {
      ...state,
      unreadAgentCompletionPanes: { [`${FLOATING_TAB}:leaf-1`]: true }
    }
    expect(select(state)).toBe(1)
    state = {
      ...state,
      tabsByWorktree: { ...state.tabsByWorktree, [FLOATING_TERMINAL_WORKTREE_ID]: [] }
    }
    expect(select(state)).toBe(0)
  })

  it('counts several unread floating tabs as one workspace', () => {
    const second = 'floating-tab-2'
    const state = makeState({
      tabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          makeTerminalTab({ id: FLOATING_TAB, worktreeId: FLOATING_TERMINAL_WORKTREE_ID }),
          makeTerminalTab({ id: second, worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
        ]
      },
      unreadTerminalTabs: { [FLOATING_TAB]: 'terminal-bell', [second]: 'terminal-bell' },
      unreadAgentCompletionPanes: { [`${second}:leaf-1`]: true }
    })

    expect(select(state)).toBe(1)
  })

  it('counts floating unread only while the floating terminal is enabled', () => {
    const floatingUnread = makeState({ unreadTerminalTabs: { [FLOATING_TAB]: 'terminal-bell' } })
    const floatingSelector = vi.fn(selectFloatingWorkspaceHasUnread)
    const gated = createUnreadBadgeCountSelector<BadgeTestState>(floatingSelector)

    expect(gated({ ...floatingUnread, settings: null })).toBe(0)
    expect(gated({ ...floatingUnread, settings: { floatingTerminalEnabled: false } })).toBe(0)
    expect(floatingSelector).not.toHaveBeenCalled()
    expect(gated(floatingUnread)).toBe(1)
    expect(gated({ ...floatingUnread, settings: { floatingTerminalEnabled: false } })).toBe(0)
    // Hiding the feature never mutates the underlying markers.
    expect(floatingUnread.unreadTerminalTabs).toEqual({ [FLOATING_TAB]: 'terminal-bell' })
  })
})
