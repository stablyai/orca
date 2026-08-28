/** @vitest-environment happy-dom */
/**
 * Crash cluster "React #185 whose component_stack names SortableTab"
 * (boundary terminal.workbench, app 1.4.190).
 *
 * useTabAgent's signal effect re-runs on every tab-model write that touches the
 * title — a working agent republishes an OSC spinner frame many times a second,
 * re-minting tabsByWorktree — and it used to dispatch setHasObservedAgentSignal(true)
 * on every run, including the overwhelming majority where the flag was already true.
 * That dispatch costs a second render+commit of SortableTab per title frame, and it
 * puts a dispatchSetState on SortableTab's fiber inside commitHookEffectListMount —
 * the exact frame the #185 reports blame (see shared/react-update-depth-attribution.ts:
 * the throw lands on whoever dispatches next after a root-global counter trips).
 *
 * Same defect and same remedy as the cold-park fix in
 * terminal-cold-park-tab-model-identity.react185.test.tsx.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { useTabAgent } from './use-tab-agent'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initialAppState = useAppStore.getInitialState()
const WORKTREE_ID = 'repo::/tab-agent-observed-signal'
const TAB_ID = 'terminal-tab-observed-signal'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const TITLE_PUBLICATIONS = 10

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
function publishRuntimeTitle(revision: number): void {
  useAppStore.setState(
    (state) =>
      ({
        tabsByWorktree: {
          ...state.tabsByWorktree,
          [WORKTREE_ID]: [terminalTab(`⠋ codex ${revision}`)]
        }
      }) as never
  )
}

let probeRenders = 0
let latestAgent: TuiAgent | null = null

/** Stands in for SortableTab, useTabAgent's only production caller. */
function TabAgentProbe(): null {
  probeRenders += 1
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
    probeRenders = 0
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

  it('schedules no extra commit for a title publication that changes no agent signal', () => {
    probeRenders = 0
    for (let revision = 1; revision <= TITLE_PUBLICATIONS; revision += 1) {
      act(() => publishRuntimeTitle(revision))
    }
    // One commit per publication. Re-dispatching the unchanged observed-signal
    // flag doubled this, and put SortableTab's fiber in every #185 stack.
    expect(probeRenders).toBe(TITLE_PUBLICATIONS)
    expect(latestAgent).toBe('codex')
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
