import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { createTestStore, makeTab, makeLayout } from './store-test-helpers'
import { makePaneKey } from '../../../../shared/stable-pane-id'

describe('swapTerminalPaneSessions store action', () => {
  it('atomically swaps terminal sessions and all pane-keyed status across tabs', () => {
    const store = createTestStore()

    const TAB_A = 'tab-a'
    const TAB_B = 'tab-b'
    const LEAF_A = '11111111-1111-4111-8111-111111111111'
    const LEAF_B = '22222222-2222-4222-8222-222222222222'
    const PANE_A = makePaneKey(TAB_A, LEAF_A)
    const PANE_B = makePaneKey(TAB_B, LEAF_B)

    // Seed tabs and layouts
    const tabA = makeTab({ id: TAB_A, worktreeId: 'wt-1' })
    const tabB = makeTab({ id: TAB_B, worktreeId: 'wt-1' })

    const layoutA = makeLayout()
    layoutA.root = { type: 'leaf', leafId: LEAF_A }
    layoutA.activeLeafId = LEAF_A
    layoutA.ptyIdsByLeafId = { [LEAF_A]: 'pty-a' }

    const layoutB = makeLayout()
    layoutB.root = { type: 'leaf', leafId: LEAF_B }
    layoutB.activeLeafId = LEAF_B
    layoutB.ptyIdsByLeafId = { [LEAF_B]: 'pty-b' }

    store.setState({
      tabsByWorktree: { 'wt-1': [tabA, tabB] },
      terminalLayoutsByTabId: {
        [TAB_A]: layoutA,
        [TAB_B]: layoutB
      },
      ptyIdsByTabId: {
        [TAB_A]: ['pty-a'],
        [TAB_B]: ['pty-b']
      },
      agentStatusByPaneKey: {
        [PANE_A]: {
          paneKey: PANE_A,
          tabId: TAB_A,
          state: 'working',
          prompt: 'Prompt A',
          agentType: 'codex'
        } as unknown as AgentStatusEntry,
        [PANE_B]: {
          paneKey: PANE_B,
          tabId: TAB_B,
          state: 'waiting',
          prompt: 'Prompt B',
          agentType: 'claude'
        } as unknown as AgentStatusEntry
      },
      unreadTerminalPanes: {
        [PANE_A]: true
      }
    })

    // Execute swap
    const success = store.getState().swapTerminalPaneSessions(TAB_A, LEAF_A, TAB_B, LEAF_B)
    expect(success).toBe(true)

    const nextState = store.getState()

    // Assert layouts are updated with swapped PTYs
    expect(nextState.terminalLayoutsByTabId[TAB_A].ptyIdsByLeafId?.[LEAF_A]).toBe('pty-b')
    expect(nextState.terminalLayoutsByTabId[TAB_B].ptyIdsByLeafId?.[LEAF_B]).toBe('pty-a')

    // Assert tab ptyIds are swapped
    expect(nextState.ptyIdsByTabId[TAB_A]).toEqual(['pty-b'])
    expect(nextState.ptyIdsByTabId[TAB_B]).toEqual(['pty-a'])

    // Assert agentStatus is relocated/swapped
    expect(nextState.agentStatusByPaneKey[PANE_A]).toEqual({
      paneKey: PANE_A,
      tabId: TAB_A,
      state: 'waiting', // from B's state, but re-keyed to A
      prompt: 'Prompt B',
      agentType: 'claude'
    })
    expect(nextState.agentStatusByPaneKey[PANE_B]).toEqual({
      paneKey: PANE_B,
      tabId: TAB_B,
      state: 'working', // from A's state, but re-keyed to B
      prompt: 'Prompt A',
      agentType: 'codex'
    })

    // Assert unread state is swapped
    expect(nextState.unreadTerminalPanes[PANE_A]).toBeUndefined()
    expect(nextState.unreadTerminalPanes[PANE_B]).toBe(true)
  })
})
