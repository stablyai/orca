import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import {
  createTestStore,
  makeTab,
  makeTabGroup,
  makeUnifiedTab
} from '@/store/slices/store-test-helpers'
import { isTabOnVisibleSurface, resolveAutoAckTabTargets } from './agent-auto-ack-targets'

const FLOATING = FLOATING_TERMINAL_WORKTREE_ID
const TERMINAL = 'terminal-tab'
const GROUP = 'group-1'

function floatingStore() {
  const store = createTestStore()
  store.setState({
    settings: { ...getDefaultSettings('/home/test'), floatingTerminalEnabled: true },
    floatingWorkspacePanelOpen: true,
    activeView: 'activity',
    activeTabIdByWorktree: { [FLOATING]: TERMINAL },
    activeGroupIdByWorktree: { [FLOATING]: GROUP },
    tabsByWorktree: { [FLOATING]: [makeTab({ id: TERMINAL, worktreeId: FLOATING })] },
    unifiedTabsByWorktree: {
      [FLOATING]: [makeUnifiedTab({ id: TERMINAL, worktreeId: FLOATING, groupId: GROUP })]
    },
    groupsByWorktree: {
      [FLOATING]: [makeTabGroup({ id: GROUP, worktreeId: FLOATING, activeTabId: TERMINAL })]
    }
  })
  return store
}

describe('visible agent acknowledgement target', () => {
  it.each(['editor', 'browser'] as const)(
    'does not treat a remembered terminal as viewed behind an active %s tab',
    (contentType) => {
      const store = floatingStore()
      const content = makeUnifiedTab({
        id: `${contentType}-tab`,
        worktreeId: FLOATING,
        groupId: GROUP,
        contentType
      })
      store.setState({
        unifiedTabsByWorktree: {
          [FLOATING]: [...store.getState().unifiedTabsByWorktree[FLOATING], content]
        },
        groupsByWorktree: {
          [FLOATING]: [makeTabGroup({ id: GROUP, worktreeId: FLOATING, activeTabId: content.id })]
        }
      })

      expect(store.getState().getActiveTab(FLOATING)?.id).toBe(content.id)
      expect(isTabOnVisibleSurface(store.getState(), FLOATING, TERMINAL, 'terminal')).toBe(false)
      expect(resolveAutoAckTabTargets(store.getState())).toEqual([])
    }
  )

  it('does not acknowledge a terminal in another group when the focused split is empty', () => {
    const store = floatingStore()
    store.setState({
      activeGroupIdByWorktree: { [FLOATING]: 'empty-group' },
      groupsByWorktree: {
        [FLOATING]: [
          makeTabGroup({ id: GROUP, worktreeId: FLOATING, activeTabId: TERMINAL }),
          makeTabGroup({ id: 'empty-group', worktreeId: FLOATING })
        ]
      }
    })

    expect(store.getState().getActiveTab(FLOATING)).toBeNull()
    expect(isTabOnVisibleSurface(store.getState(), FLOATING, TERMINAL, 'terminal')).toBe(false)
    expect(resolveAutoAckTabTargets(store.getState())).toEqual([])
  })

  it('acknowledges the active terminal in the focused group', () => {
    const state = floatingStore().getState()

    expect(isTabOnVisibleSurface(state, FLOATING, TERMINAL, 'terminal')).toBe(true)
  })
})
