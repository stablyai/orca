// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { Tab, TabContentType, TabGroup } from '../../../../shared/tab-types'
import { useTabGroupCloseScopeCommands } from './useTabGroupCloseScopeCommands'

const mocks = vi.hoisted(() => {
  const state: {
    groupsByWorktree: Record<string, TabGroup[]>
    unifiedTabsByWorktree: Record<string, Tab[]>
  } = { groupsByWorktree: {}, unifiedTabsByWorktree: {} }
  return { track: vi.fn(), closeEmptyGroup: vi.fn(), state }
})

vi.mock('@/lib/telemetry', () => ({ track: mocks.track }))
vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: { closeEmptyGroup: () => void }) => unknown) => selector(mocks),
    { getState: () => mocks.state }
  )
}))
vi.mock('../confirmation-dialog-context', () => ({
  useConfirmationDialog: () => async () => true
}))
vi.mock('./workspace-emptied-reaction', () => ({
  captureWorkspaceEmptiedReaction: vi.fn(() => vi.fn())
}))

function tab(id: string, contentType: TabContentType = 'terminal', isPinned = false): Tab {
  return {
    id,
    entityId: id,
    contentType,
    groupId: 'group-1',
    worktreeId: 'worktree-1',
    label: 'private tab title',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    isPinned
  }
}

function commands({
  worktreeId = 'worktree-1',
  contentType = 'terminal',
  closeMany = vi.fn()
}: {
  worktreeId?: string
  contentType?: TabContentType
  closeMany?: (ids: string[]) => void
} = {}) {
  const group: TabGroup = {
    id: 'group-1',
    worktreeId,
    activeTabId: 'selected',
    tabOrder: ['left', 'pinned-left', 'selected', 'right', 'pinned-right', 'missing', 'last']
  }
  // Storage order differs from the visible order; pinned and missing tabs must not count.
  const groupTabs = [
    tab('last'),
    tab('selected', contentType),
    tab('pinned-left', 'terminal', true),
    tab('pinned-right', 'terminal', true),
    tab('right'),
    tab('left')
  ]
  mocks.state = {
    groupsByWorktree: { [worktreeId]: [group] },
    unifiedTabsByWorktree: { [worktreeId]: groupTabs }
  }
  const hook = renderHook(() =>
    useTabGroupCloseScopeCommands({
      groupId: group.id,
      worktreeId,
      closeItem: vi.fn(),
      closeMany
    })
  )
  return { ...hook.result.current, closeMany }
}

beforeEach(() => vi.clearAllMocks())

describe('directional tab close telemetry', () => {
  it.each(['left', 'right'] as const)(
    'counts one %s request before asking to close tabs',
    async (direction) => {
      const expectedIds = direction === 'left' ? ['left'] : ['right', 'last']
      const closeMany = vi.fn((ids: string[]) => {
        expect(mocks.track).toHaveBeenCalledExactlyOnceWith('tabs_directional_close_requested', {
          direction,
          tab_type: 'terminal',
          surface: 'workspace',
          eligible_tab_count: expectedIds.length
        })
        expect(ids).toEqual(expectedIds)
        // The close flow can leave these tabs open after a cancelled save prompt.
      })
      const scope = commands({ closeMany })

      await act(async () => {
        if (direction === 'left') {
          scope.closeToLeft('selected')
        } else {
          scope.closeToRight('selected')
        }
      })

      expect(closeMany).toHaveBeenCalledExactlyOnceWith(expectedIds)
    }
  )

  it.each([
    ['terminal', 'terminal'],
    ['editor', 'editor'],
    ['diff', 'editor'],
    ['conflict-review', 'editor'],
    ['check-details', 'editor'],
    ['agent-session', 'agent-session'],
    ['browser', 'browser'],
    ['simulator', 'simulator']
  ] as const)('reports %s tabs as %s in the floating panel', (contentType, tabType) => {
    commands({ worktreeId: FLOATING_TERMINAL_WORKTREE_ID, contentType }).closeToLeft('selected')

    expect(mocks.track).toHaveBeenCalledExactlyOnceWith('tabs_directional_close_requested', {
      direction: 'left',
      tab_type: tabType,
      surface: 'floating',
      eligible_tab_count: 1
    })
  })

  it('records an empty selection as a request with no eligible tabs', () => {
    const scope = commands()
    scope.closeToLeft('left')

    expect(mocks.track).toHaveBeenCalledExactlyOnceWith('tabs_directional_close_requested', {
      direction: 'left',
      tab_type: 'terminal',
      surface: 'workspace',
      eligible_tab_count: 0
    })
    expect(scope.closeMany).not.toHaveBeenCalled()
  })

  it('does not count stale tab ids or unrelated close commands', () => {
    const scope = commands()
    scope.closeToLeft('stale')
    scope.closeToRight('stale')
    scope.closeOthers('selected')
    scope.closeAllEditorTabsInGroup()

    expect(mocks.track).not.toHaveBeenCalled()
  })
})
