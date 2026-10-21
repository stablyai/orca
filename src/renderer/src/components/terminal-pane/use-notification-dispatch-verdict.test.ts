import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import {
  PANE_KEY,
  getLastNotificationDispatchArg,
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

// The hook lane hands main the row's verdict, read through the one accessor, so a terminal
// agent's StopFailure is worded "failed" rather than "finished".
describe('dispatchTerminalNotification verdict', () => {
  beforeEach(() => {
    mockState = resetNotificationDispatchMockState()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    [{ mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 1 } }, 'failure'],
    [{ mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 1 } }, 'cancellation'],
    [{ interrupted: true }, 'cancellation'],
    [{}, undefined]
  ] as const)('passes %j as the turn outcome %s', (overrides, outcome) => {
    mockState.agentStatusByPaneKey[PANE_KEY] = makeAgentStatus(PANE_KEY, overrides)

    dispatchTerminalNotification('wt-primary', {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: PANE_KEY
    })

    expect(getLastNotificationDispatchArg()).toMatchObject({
      agentState: 'done',
      agentTurnOutcome: outcome
    })
  })
})
