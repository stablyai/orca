import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  moveTerminalTabToWorktreeInStore,
  type TerminalTabMoveStoreState
} from './move-terminal-tab-to-worktree'

const SOURCE = 'repo::/src'
const DEST = 'repo::/dest'
const TAB_ID = 'tab-1'
const PANE_KEY = makePaneKey(TAB_ID, '11111111-1111-4111-8111-111111111111')

function state(): TerminalTabMoveStoreState {
  return {
    tabsByWorktree: {
      [SOURCE]: [
        {
          id: TAB_ID,
          ptyId: 'pty-1',
          worktreeId: SOURCE,
          title: 'Agent',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ],
      [DEST]: []
    },
    unifiedTabsByWorktree: {
      [SOURCE]: [
        {
          id: TAB_ID,
          entityId: TAB_ID,
          groupId: 'group-src',
          worktreeId: SOURCE,
          contentType: 'terminal',
          label: 'Agent',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ],
      [DEST]: []
    },
    groupsByWorktree: {
      [SOURCE]: [
        {
          id: 'group-src',
          worktreeId: SOURCE,
          activeTabId: TAB_ID,
          tabOrder: [TAB_ID],
          recentTabIds: [TAB_ID]
        }
      ]
    },
    layoutByWorktree: {
      [SOURCE]: { type: 'leaf', groupId: 'group-src' }
    },
    activeGroupIdByWorktree: { [SOURCE]: 'group-src' },
    tabBarOrderByWorktree: { [SOURCE]: [TAB_ID], [DEST]: [] },
    activeTabIdByWorktree: { [SOURCE]: TAB_ID, [DEST]: null },
    activeTabId: TAB_ID,
    agentStatusByPaneKey: {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        tabId: TAB_ID,
        worktreeId: SOURCE,
        agentType: 'codex',
        state: 'working',
        prompt: 'review',
        updatedAt: 1,
        stateStartedAt: 1,
        stateHistory: []
      } satisfies AgentStatusEntry
    },
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        tabId: TAB_ID,
        worktreeId: SOURCE,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'session-1' },
        prompt: 'review',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1
      } satisfies SleepingAgentSessionRecord
    }
  }
}

describe('moveTerminalTabToWorktreeInStore', () => {
  it('moves the live tab, bar order, and hook attribution to the destination', () => {
    const result = moveTerminalTabToWorktreeInStore(state(), TAB_ID, DEST)
    expect(result).not.toBeNull()
    expect(result?.patch.tabsByWorktree?.[SOURCE]).toEqual([])
    expect(result?.patch.tabsByWorktree?.[DEST]).toEqual([
      expect.objectContaining({ id: TAB_ID, worktreeId: DEST, ptyId: 'pty-1' })
    ])
    expect(result?.patch.tabBarOrderByWorktree?.[SOURCE]).toEqual([])
    expect(result?.patch.tabBarOrderByWorktree?.[DEST]).toEqual([TAB_ID])
    expect(result?.patch.unifiedTabsByWorktree?.[DEST]?.[0]).toMatchObject({
      id: TAB_ID,
      worktreeId: DEST
    })
    expect(result?.patch.agentStatusByPaneKey?.[PANE_KEY]?.worktreeId).toBe(DEST)
    expect(result?.patch.sleepingAgentSessionsByPaneKey?.[PANE_KEY]?.worktreeId).toBe(DEST)
  })

  it('does not move when the destination is the source or the tab is missing', () => {
    expect(moveTerminalTabToWorktreeInStore(state(), TAB_ID, SOURCE)).toBeNull()
    expect(moveTerminalTabToWorktreeInStore(state(), 'missing', DEST)).toBeNull()
  })

  it('remints sleeping agent sessions onto the destination worktree', () => {
    const result = moveTerminalTabToWorktreeInStore(state(), TAB_ID, DEST)
    expect(result?.patch.sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
      tabId: TAB_ID,
      worktreeId: DEST
    })
  })
})
