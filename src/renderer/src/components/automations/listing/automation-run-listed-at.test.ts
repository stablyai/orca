import { describe, expect, it } from 'vitest'
import { getAutomationRunLaunchedAt } from '../runs/automation-run-identity-label'

describe('when a run launched', () => {
  const run = (overrides: Partial<Parameters<typeof getAutomationRunLaunchedAt>[0]>) => ({
    status: 'dispatch_failed' as const,
    dispatchedAt: null,
    startedAt: null,
    chatSessionId: null,
    terminalPaneKey: null,
    sessionKind: 'chat' as const,
    launchedAt: undefined,
    ...overrides
  })

  it('is unknown when the chat launcher refused or threw before starting anything', () => {
    // The producer stamps dispatchedAt in its chat catch branch; that is not a launch.
    expect(getAutomationRunLaunchedAt(run({ dispatchedAt: 5 }))).toBeNull()
    expect(
      getAutomationRunLaunchedAt(run({ status: 'skipped_unavailable', dispatchedAt: 5 }))
    ).toBeNull()
  })

  it('uses the recorded launch time of a run that failed after launching', () => {
    // Delivery failed before dispatch, then retention cleared the pane: only launchedAt remains.
    expect(getAutomationRunLaunchedAt(run({ sessionKind: 'terminal', launchedAt: 7 }))).toBe(7)
    expect(getAutomationRunLaunchedAt(run({ launchedAt: 7 }))).toBe(7)
  })

  it('keeps a launched terminal run whose pane key retention cleared', () => {
    // Terminal runs get dispatchedAt only at dispatch; retention later drops the pane key.
    expect(getAutomationRunLaunchedAt(run({ sessionKind: 'terminal', dispatchedAt: 5 }))).toBe(5)
  })
})
