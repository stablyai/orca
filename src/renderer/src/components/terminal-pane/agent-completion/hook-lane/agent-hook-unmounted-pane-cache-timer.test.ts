import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTab } from '../../../../store/terminals/testing/terminal-tab.test-fixture'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import {
  observeAgentHookCompletionForNotification,
  resetAgentHookCompletionNotificationCoordinators
} from './agent-hook-completion-notifications'

vi.mock('@/store', async () => {
  const { createTestStore } = await import('../../../../store/testing/app-store-test-fixture')
  return { useAppStore: createTestStore() }
})
vi.mock('../../notifications/dispatch-terminal-notification', () => ({
  dispatchTerminalNotification: () => {}
}))

const LEAF = '11111111-1111-4111-8111-111111111111'
const TAB = 'web-terminal-host-tab'
const PANE = `${TAB}:${LEAF}`

function seedPlacedPane(): void {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, promptCacheTimerEnabled: true },
    tabsByWorktree: { 'wt-1': [makeTab({ id: TAB, worktreeId: 'wt-1' })] },
    terminalLayoutsByTabId: {
      [TAB]: { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
    },
    // The host mirror's row for the pane's agent; the hook lane only times a live agent.
    agentStatusByPaneKey: acceptedAgentStatuses([
      [
        PANE,
        {
          state: 'working',
          prompt: 'hi',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          agentType: 'claude',
          paneKey: PANE,
          tabId: TAB,
          worktreeId: 'wt-1'
        }
      ]
    ])
  })
}

function observe(state: 'working' | 'done'): void {
  observeAgentHookCompletionForNotification({
    paneKey: PANE,
    worktreeId: 'wt-1',
    payload: { state, prompt: 'hi', agentType: 'claude' }
  })
}

afterEach(() => {
  resetAgentHookCompletionNotificationCoordinators()
  vi.useRealTimers()
})

describe('hook-lane prompt cache timer for a pane no window mounted', () => {
  it('starts on a Claude turn end and clears when the next turn starts', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    seedPlacedPane()
    observe('working')
    observe('done')
    // The hook lane holds a Done for its quiet window before ending the turn.
    vi.advanceTimersByTime(1_500)
    expect(useAppStore.getState().cacheTimerByKey[PANE]).toBe(1_800_000_001_500)
    observe('working')
    expect(useAppStore.getState().cacheTimerByKey[PANE]).toBeNull()
  })
})
