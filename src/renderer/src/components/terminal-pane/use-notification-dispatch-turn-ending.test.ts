import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import {
  PANE_KEY,
  makeAgentStatus,
  resetNotificationDispatchMockState,
  type NotificationDispatchMockState
} from './notification-dispatch-test-harness'

vi.mock('@/store', async () => {
  const harness = await import('./notification-dispatch-test-harness')
  return harness.createNotificationDispatchStoreModuleMock()
})

vi.mock('@/lib/desktop-notification-sound', async () => {
  const harness = await import('./notification-dispatch-test-harness')
  return harness.createDesktopNotificationSoundModuleMock()
})

let mockState: NotificationDispatchMockState

// The wording is main's; the renderer's job is to hand it how the main agent's turn ended, read
// from the main agent record whenever the snapshot carries one.
describe('dispatchTerminalNotification turn ending', () => {
  beforeEach(() => {
    mockState = resetNotificationDispatchMockState()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('carries a failure from the held-open completion snapshot the hook observer builds', () => {
    const turnCompletedAt = Date.now()
    mockState.agentStatusByPaneKey[PANE_KEY] = makeAgentStatus(PANE_KEY, {
      state: 'working',
      agentType: 'claude',
      terminalTitle: 'claude'
    })

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'claude',
      paneKey: PANE_KEY,
      agentStatusSnapshot: {
        state: 'done',
        prompt: 'review the PR',
        agentType: 'claude',
        stateStartedAt: turnCompletedAt,
        turnCompletedAt,
        mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: turnCompletedAt }
      }
    })

    expect(window.api.notifications.dispatch).toHaveBeenCalledTimes(1)
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ agentState: 'done', agentTurnEnding: 'failure' })
    )
  })

  it('carries a cancellation from the stored row and nothing for a clean finish', () => {
    mockState.agentStatusByPaneKey[PANE_KEY] = makeAgentStatus(PANE_KEY, { interrupted: true })
    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: PANE_KEY
    })
    expect(window.api.notifications.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentTurnEnding: 'cancellation' })
    )

    mockState = resetNotificationDispatchMockState()
    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: PANE_KEY
    })
    expect(window.api.notifications.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentState: 'done', agentTurnEnding: undefined })
    )
  })
})
