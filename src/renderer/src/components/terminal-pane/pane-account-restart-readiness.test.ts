import { beforeEach, describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { selectReadyAccountRestartPtyIds } from './pane-account-restart-readiness'

const LEAF = '11111111-1111-4111-8111-111111111111'

function status(tabId: string, state: AgentStatusEntry['state']): AgentStatusEntry {
  const paneKey = makePaneKey(tabId, LEAF)
  return {
    paneKey,
    tabId,
    state,
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    agentType: 'claude'
  }
}

function setStatuses(...entries: AgentStatusEntry[]): void {
  useAppStore.setState({
    agentStatusByPaneKey: Object.fromEntries(entries.map((entry) => [entry.paneKey, entry]))
  })
}

const ready = (): string[] => selectReadyAccountRestartPtyIds(useAppStore.getState(), 'tab-1')

describe('selectReadyAccountRestartPtyIds', () => {
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
})
