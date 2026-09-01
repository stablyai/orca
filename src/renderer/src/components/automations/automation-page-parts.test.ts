import { describe, expect, it } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { PersistedAgentLaunchFailure } from '../../../../shared/agent-launch-contract'
import { getAutomationRunRowBadge } from './automation-page-parts'

function makeLaunchFailure(
  overrides: Partial<PersistedAgentLaunchFailure> = {}
): PersistedAgentLaunchFailure {
  return {
    version: 1,
    failureId: 'failure-1',
    intent: 'automation',
    occurredAt: 1,
    code: 'launch_state_unknown',
    ...overrides
  }
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    title: 'Run 1',
    scheduledFor: 1,
    status: 'completed',
    trigger: 'manual',
    workspaceId: 'wt-1',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab-1',
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 1,
    dispatchedAt: 1,
    createdAt: 1,
    ...overrides
  }
}

describe('getAutomationRunRowBadge', () => {
  it('flags a run stranded mid-dispatch as a failed launch instead of "Starting"', () => {
    expect(
      getAutomationRunRowBadge(
        makeRun({ status: 'dispatching', agentLaunchFailure: makeLaunchFailure() })
      )
    ).toEqual({ label: "Didn't start", variant: 'destructive' })
  })

  it('shows a muted forgotten badge once a stranded run is forgotten', () => {
    expect(
      getAutomationRunRowBadge(
        makeRun({
          status: 'dispatching',
          agentLaunchFailure: makeLaunchFailure(),
          agentLaunchForgottenAt: 42
        })
      )
    ).toEqual({ label: 'Forgotten', variant: 'outline' })
  })

  it('surfaces a launch failure that stalls a run before it leaves the pending queue', () => {
    expect(
      getAutomationRunRowBadge(
        makeRun({ status: 'pending', agentLaunchFailure: makeLaunchFailure() })
      )
    ).toEqual({ label: "Didn't start", variant: 'destructive' })
  })

  it('leaves a genuinely in-progress dispatch showing its default badge', () => {
    expect(getAutomationRunRowBadge(makeRun({ status: 'dispatching' }))).toEqual({
      label: 'Starting',
      variant: 'dot'
    })
  })

  it('does not override a run whose status already reports the failure', () => {
    expect(
      getAutomationRunRowBadge(
        makeRun({ status: 'dispatch_failed', agentLaunchFailure: makeLaunchFailure() })
      )
    ).toEqual({ label: 'Failed', variant: 'destructive' })
  })

  it('keeps the default badge for a completed run', () => {
    expect(getAutomationRunRowBadge(makeRun({ status: 'completed' }))).toEqual({
      label: 'Done',
      variant: 'secondary'
    })
  })
})
