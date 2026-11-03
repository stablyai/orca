import { beforeEach, describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { selectReadyAccountRestartPtyIds } from './pane-account-restart-readiness'

const LEAF = '11111111-1111-4111-8111-111111111111'

const ready = (tabId: string): string[] =>
  selectReadyAccountRestartPtyIds(useAppStore.getState(), tabId)

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

  it("runs this tab's Claude restart at once, even mid-turn", () => {
    useAppStore.setState({
      agentStatusByPaneKey: {
        [makePaneKey('tab-1', LEAF)]: {
          paneKey: makePaneKey('tab-1', LEAF),
          tabId: 'tab-1',
          state: 'working',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          agentType: 'claude'
        }
      }
    })
    useAppStore.getState().queuePaneAccountRestarts(['tab-1-pty'], 'claude')
    expect(ready('tab-1')).toEqual(['tab-1-pty'])
  })

  it("leaves another tab's selection equal when a Claude restart is queued here", () => {
    const before = ready('tab-2')
    useAppStore.getState().queuePaneAccountRestarts(['tab-1-pty'], 'claude')
    expect(shallow(before, ready('tab-2'))).toBe(true)
  })
})
