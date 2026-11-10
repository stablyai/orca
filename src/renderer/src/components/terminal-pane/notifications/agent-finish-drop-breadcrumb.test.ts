import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../store/index', async () =>
  (await import('./notification-dispatch-test-harness')).createNotificationDispatchStoreModuleMock()
)

import {
  makeAgentStatus,
  PANE_KEY,
  resetNotificationDispatchMockState
} from './notification-dispatch-test-harness'
import { dispatchTerminalNotification } from './dispatch-terminal-notification'

describe('a dropped agent finish (#40340)', () => {
  const recordBreadcrumb = vi.fn()

  beforeEach(() => {
    const state = resetNotificationDispatchMockState()
    state.agentStatusByPaneKey[PANE_KEY] = makeAgentStatus(PANE_KEY, { state: 'working' })
    vi.stubGlobal('window', {
      api: {
        notifications: { dispatch: vi.fn().mockResolvedValue({ delivered: true }) },
        crashReports: { recordBreadcrumb }
      }
    })
  })

  it('leaves a breadcrumb naming why it marked nothing unread', () => {
    const dispatched = dispatchTerminalNotification('wt-1', {
      source: 'agent-task-complete',
      paneKey: PANE_KEY,
      terminalTitle: 'codex'
    })

    expect(dispatched).toBe(false)
    expect(recordBreadcrumb).toHaveBeenCalledWith({
      name: 'agent_finish_dropped',
      data: { cause: 'fresh-active-hook-status', workspaceId: 'wt-1', paneKey: PANE_KEY }
    })
  })
})
