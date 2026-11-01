import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPresenceGated } from '@/hooks/agent-auto-ack-presence'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import {
  PANE_KEY,
  makeAgentStatus,
  resetNotificationDispatchMockState,
  type NotificationDispatchMockState
} from './notification-dispatch-test-harness'

const NOW = 1_800_000_000_000
const paneKey = PANE_KEY

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  setPresenceGated(false)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setPresenceGated(true)
})

vi.mock('@/store', async () => {
  const harness = await import('./notification-dispatch-test-harness')
  return harness.createNotificationDispatchStoreModuleMock()
})

vi.mock('@/lib/desktop-notification-sound', async () => {
  const harness = await import('./notification-dispatch-test-harness')
  return harness.createDesktopNotificationSoundModuleMock()
})

let mockState: NotificationDispatchMockState

describe('dispatchTerminalNotification for a dispatched worker', () => {
  beforeEach(() => {
    mockState = resetNotificationDispatchMockState()
    mockState.runtimeAgentOrchestrationByPaneKey[paneKey] = {
      taskId: 'task_1',
      dispatchId: 'ctx_1',
      parentPaneKey: 'tab-c:leaf-c'
    }
  })

  it('leaves its hook-proven finished turn to its coordinator', () => {
    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey
    })
    expect(mockState.markAgentAttentionUnread).not.toHaveBeenCalled()
    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()
  })

  // Each of these stops either needs the person or reported to no one.
  it.each([
    {
      stop: 'a hook row waiting on a prompt',
      row: () => makeAgentStatus(paneKey, { state: 'waiting', stateStartedAt: NOW + 1 }),
      title: 'codex',
      fromSnapshot: true
    },
    // The fresh `done` row is the previous turn's; the approval title is this one's.
    {
      stop: 'a title waiting for approval',
      row: undefined,
      title: 'Codex - waiting for approval'
    },
    { stop: 'a hookless title-only stop', row: null, title: 'codex' },
    {
      stop: 'an agent that exited mid-turn',
      row: () => makeAgentStatus(paneKey, { state: 'working' }),
      title: 'claude',
      exited: true
    }
  ])('still calls the user to $stop', ({ row, title, fromSnapshot, exited }) => {
    const entry = row === null ? null : row?.()
    if (entry === null) {
      delete mockState.agentStatusByPaneKey[paneKey]
    } else if (entry) {
      mockState.agentStatusByPaneKey[paneKey] = entry
    }
    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: title,
      paneKey,
      ...(fromSnapshot && entry ? { agentStatusSnapshot: entry } : {}),
      ...(exited ? { agentCompletionSource: 'process-exit' as const } : {})
    })
    expect(mockState.markAgentAttentionUnread).toHaveBeenCalled()
    expect(window.api.notifications.dispatch).toHaveBeenCalled()
  })
})
