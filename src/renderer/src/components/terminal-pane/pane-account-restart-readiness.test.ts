import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  recordTerminalInputActivity,
  resetTerminalInputActivityCoalescingForTests
} from '@/lib/terminal-input-activity-coalescing'
import { selectReadyAccountRestartPtyIds } from './pane-account-restart-readiness'

const LEAF = '11111111-1111-4111-8111-111111111111'

function status(
  tabId: string,
  state: AgentStatusEntry['state'],
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  const paneKey = makePaneKey(tabId, LEAF)
  return {
    paneKey,
    tabId,
    state,
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 10,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

function setStatuses(...entries: AgentStatusEntry[]): void {
  useAppStore.setState({
    agentStatusByPaneKey: Object.fromEntries(entries.map((entry) => [entry.paneKey, entry]))
  })
}

const ready = (): string[] => selectReadyAccountRestartPtyIds(useAppStore.getState(), 'tab-1')

describe('selectReadyAccountRestartPtyIds', () => {
  afterEach(resetTerminalInputActivityCoalescingForTests)
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({
      terminalLayoutsByTabId: Object.fromEntries(
        ['tab-1', 'tab-2'].map((tabId) => [
          tabId,
          {
            root: { type: 'leaf', leafId: LEAF },
            activeLeafId: LEAF,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF]: `${tabId}-pty` }
          }
        ])
      )
    })
  })

  it("holds this tab's Claude restart until its turn ends", () => {
    setStatuses(status('tab-1', 'working'))
    useAppStore.getState().queuePaneAccountRestarts(['tab-1-pty'], 'claude')
    expect(ready()).toEqual([])

    setStatuses(status('tab-1', 'done'))
    expect(ready()).toEqual(['tab-1-pty'])
  })

  it("gives an equal result when only another tab's status changes", () => {
    setStatuses(status('tab-1', 'working'), status('tab-2', 'working'))
    useAppStore.getState().queuePaneAccountRestarts(['tab-1-pty', 'tab-2-pty'], 'claude')
    const before = ready()

    setStatuses(status('tab-1', 'working'), status('tab-2', 'done'))

    expect(shallow(before, ready())).toBe(true)
  })

  it('treats a Codex restart as ready at once', () => {
    useAppStore.getState().queuePaneAccountRestarts(['codex-pty'], 'codex')
    expect(ready()).toEqual(['codex-pty'])
  })

  it.each([
    [
      'a subagent still running',
      { subagents: [{ id: 'sub-1', state: 'working' as const, startedAt: 1 }] }
    ],
    [
      'a dispatch that is not finished',
      { orchestration: { taskId: 't', dispatchId: 'd', dispatchStatus: 'dispatched' as const } }
    ],
    ['a dispatch with no known outcome', { orchestration: { taskId: 't', dispatchId: 'd' } }],
    ['a turn that ended in a stop or failure', { interrupted: true }]
  ])('holds a finished pane with %s, and releases it when that ends', (_name, blocker) => {
    useAppStore.getState().queuePaneAccountRestarts(['tab-1-pty'], 'claude')

    setStatuses(status('tab-1', 'done', blocker))
    expect(ready()).toEqual([])

    setStatuses(status('tab-1', 'done'))
    expect(ready()).toEqual(['tab-1-pty'])
  })

  it('restarts a finished pane whose dispatch completed and whose children are gone', () => {
    useAppStore.getState().queuePaneAccountRestarts(['tab-1-pty'], 'claude')
    setStatuses(
      status('tab-1', 'done', {
        subagents: [],
        orchestration: { taskId: 't', dispatchId: 'd', dispatchStatus: 'completed' }
      })
    )
    expect(ready()).toEqual(['tab-1-pty'])
  })

  describe('an unsent draft', () => {
    const paneKey = makePaneKey('tab-1', LEAF)
    const typed = (at: number): void =>
      useAppStore.setState({ lastTerminalInputAtByPaneKey: { [paneKey]: at } })

    beforeEach(() => {
      useAppStore.getState().queuePaneAccountRestarts(['tab-1-pty'], 'claude')
      setStatuses(status('tab-1', 'done', { stateStartedAt: 10 }))
    })

    it('holds a finished pane that was typed into after its turn ended', () => {
      typed(20)
      expect(ready()).toEqual([])
    })

    it('restarts a finished pane whose last input was sent before the turn ended', () => {
      typed(5)
      expect(ready()).toEqual(['tab-1-pty'])
    })

    it('sees the newest keystroke before the store has it', () => {
      typed(5)
      const commit = { insert: () => {}, refreshExisting: () => {} }
      recordTerminalInputActivity({ paneKey, timestamp: 5, commit })
      recordTerminalInputActivity({ paneKey, timestamp: 20, commit })
      expect(ready()).toEqual([])
    })
  })

  it('still restarts a Claude pane that reports no status', () => {
    useAppStore.getState().queuePaneAccountRestarts(['tab-1-pty'], 'claude')
    expect(ready()).toEqual(['tab-1-pty'])
  })
})
