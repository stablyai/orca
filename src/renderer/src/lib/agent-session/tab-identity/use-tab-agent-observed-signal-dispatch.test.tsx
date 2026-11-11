/** @vitest-environment happy-dom */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { useTabAgent } from './use-tab-agent'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { TerminalAgent } from '../../../../../shared/agent-status/identity/terminal-agent'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initialAppState = useAppStore.getInitialState()
const WORKTREE_ID = 'repo::/tab-agent-observed-signal'
const TAB_ID = 'terminal-tab-observed-signal'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

function paneLayout(ptyId: string): TerminalLayoutSnapshot {
  return {
    root: null,
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_ID]: ptyId }
  }
}

function workingAgentStatus(): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
    agentType: 'codex',
    paneKey: PANE_KEY,
    stateHistory: []
  } as AgentStatusEntry
}

function terminalTab(title: string): TerminalTab {
  return {
    id: TAB_ID,
    worktreeId: WORKTREE_ID,
    ptyId: 'pty-a',
    title,
    generation: 0
  } as TerminalTab
}

/** An ordinary agent spinner frame: re-mints tabsByWorktree, changes no agent signal. */

let latestAgent: TerminalAgent | null = null

/** Stands in for TerminalSortableTab, useTabAgent's only production caller. */
function TabAgentProbe(): null {
  const tab = useAppStore((state) => state.tabsByWorktree[WORKTREE_ID]?.[0]) as TerminalTab
  latestAgent = useTabAgent(tab)
  return null
}

describe('useTabAgent observed-signal dispatch', () => {
  let container: HTMLDivElement
  let root: Root | undefined

  beforeEach(() => {
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE_KEY]: workingAgentStatus() },
      terminalLayoutsByTabId: { [TAB_ID]: paneLayout('pty-a') },
      ptyIdsByTabId: { [TAB_ID]: ['pty-a'] },
      tabsByWorktree: { [WORKTREE_ID]: [terminalTab('⠋ codex 0')] }
    } as never)
    container = document.createElement('div')
    document.body.appendChild(container)
    latestAgent = null
    root = createRoot(container)
    act(() => root!.render(<TabAgentProbe />))
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    container.remove()
    useAppStore.setState(initialAppState, true)
  })

  it('still re-arms the observed signal after a pty respawn', () => {
    act(() => {
      useAppStore.setState({
        agentStatusByPaneKey: {},
        terminalLayoutsByTabId: { [TAB_ID]: paneLayout('pty-b') },
        ptyIdsByTabId: { [TAB_ID]: ['pty-b'] },
        tabsByWorktree: { [WORKTREE_ID]: [terminalTab('zsh')] }
      } as never)
    })
    expect(latestAgent).toBeNull()

    act(() => {
      useAppStore.setState({
        agentStatusByPaneKey: { [PANE_KEY]: workingAgentStatus() },
        tabsByWorktree: { [WORKTREE_ID]: [terminalTab('⠋ codex 1')] }
      } as never)
    })
    expect(latestAgent).toBe('codex')
  })
})
