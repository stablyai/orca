import { describe, expect, it } from 'vitest'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { PersistedAgentLaunchFailure } from '../../../../shared/agent-launch-contract'
import {
  AUTOMATION_RERUN_PENDING_MIN_VISIBLE_MS,
  canRerunAutomationRun,
  getAutomationRerunPendingRemainingMs,
  getAutomationRunLaunchFailure,
  getAutomationRunViewState
} from './automation-run-view-state'

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

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'automation-1',
    name: 'Automation 1',
    prompt: 'Run checks',
    precheck: null,
    agentId: 'codex',
    projectId: 'repo-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1,
    enabled: true,
    nextRunAt: 1,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1,
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
    terminalPaneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    terminalPtyId: 'pty-1',
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

describe('automation run view state', () => {
  it('opens the exact terminal when the run tab is still available', () => {
    expect(
      getAutomationRunViewState({
        run: makeRun(),
        workspaceExists: true,
        terminalTargetExists: true
      })
    ).toMatchObject({
      availability: 'terminal',
      actionLabel: 'View run',
      statusLabel: 'Run is open',
      canOpen: true
    })
  })

  it('keeps View run for exact terminal identity even before the live target is resolved', () => {
    expect(
      getAutomationRunViewState({
        run: makeRun(),
        workspaceExists: true,
        terminalTargetExists: false
      })
    ).toMatchObject({
      availability: 'terminal',
      actionLabel: 'View run',
      statusLabel: 'Run terminal is unavailable.',
      canOpen: true
    })
  })

  it('resumes the workspace only when there is no exact terminal identity', () => {
    expect(
      getAutomationRunViewState({
        run: makeRun({ terminalPaneKey: null, terminalPtyId: null }),
        workspaceExists: true,
        terminalTargetExists: false
      })
    ).toMatchObject({
      availability: 'workspace',
      actionLabel: 'Resume workspace',
      statusLabel: 'Workspace is available.'
    })
  })

  it('keeps skipped or missing-workspace runs as metadata-only history', () => {
    expect(
      getAutomationRunViewState({
        run: makeRun({ workspaceId: null, terminalSessionId: null }),
        workspaceExists: false,
        terminalTargetExists: false
      })
    ).toMatchObject({
      availability: 'metadata',
      statusLabel: 'No workspace launched',
      canOpen: false
    })
  })

  it('describes deleted workspaces without the ambiguous unavailable label', () => {
    expect(
      getAutomationRunViewState({
        run: makeRun({ workspaceDisplayName: 'Nightly Checks' }),
        workspaceExists: false,
        terminalTargetExists: false
      })
    ).toMatchObject({
      availability: 'metadata',
      statusLabel: 'Nightly Checks no longer available',
      canOpen: false
    })
  })

  it('keeps a deleted-workspace run viewable through its saved snapshot', () => {
    expect(
      getAutomationRunViewState({
        run: makeRun({
          outputSnapshot: {
            format: 'plain_text',
            content: 'Run completed',
            capturedAt: 1,
            truncated: false
          }
        }),
        workspaceExists: false,
        terminalTargetExists: false
      })
    ).toMatchObject({
      availability: 'snapshot',
      actionLabel: 'Snapshot saved',
      statusLabel: 'Showing saved run snapshot.',
      canOpen: false
    })
  })
})

describe('canRerunAutomationRun', () => {
  it.each(['dispatch_failed', 'skipped_unavailable', 'skipped_needs_interactive_auth'] as const)(
    'allows rerun for recoverable launch status %s',
    (status) => {
      expect(
        canRerunAutomationRun({
          automation: makeAutomation(),
          run: makeRun({ status })
        })
      ).toBe(true)
    }
  )

  it.each([
    'pending',
    'dispatching',
    'dispatched',
    'completed',
    'skipped_precheck',
    'skipped_missed'
  ] as const)('hides rerun for non-recoverable status %s', (status) => {
    expect(
      canRerunAutomationRun({
        automation: makeAutomation(),
        run: makeRun({ status })
      })
    ).toBe(false)
  })

  it('requires the failed run to belong to the selected automation', () => {
    expect(
      canRerunAutomationRun({
        automation: makeAutomation({ id: 'automation-2' }),
        run: makeRun({ status: 'dispatch_failed' })
      })
    ).toBe(false)
  })

  it('hides rerun when the automation no longer exists in the Orca list', () => {
    expect(
      canRerunAutomationRun({
        automation: null,
        run: makeRun({ status: 'dispatch_failed' })
      })
    ).toBe(false)
  })
})

describe('getAutomationRunLaunchFailure', () => {
  it('returns null for a run with no structured launch failure', () => {
    expect(getAutomationRunLaunchFailure(makeRun())).toBeNull()
  })

  it('surfaces the structured failure and a null forgotten time by default', () => {
    const failure = makeLaunchFailure()
    expect(getAutomationRunLaunchFailure(makeRun({ agentLaunchFailure: failure }))).toEqual({
      failure,
      forgottenAt: null
    })
  })

  it('carries the forgotten timestamp when the run was explicitly forgotten', () => {
    const failure = makeLaunchFailure()
    expect(
      getAutomationRunLaunchFailure(
        makeRun({ status: 'dispatch_failed', agentLaunchFailure: failure, agentLaunchForgottenAt: 42 })
      )
    ).toEqual({ failure, forgottenAt: 42 })
  })
})

describe('getAutomationRerunPendingRemainingMs', () => {
  it('keeps a short pending visibility window for fast rerun results', () => {
    expect(
      getAutomationRerunPendingRemainingMs({
        pendingStartedAt: 1_000,
        now: 1_000
      })
    ).toBe(AUTOMATION_RERUN_PENDING_MIN_VISIBLE_MS)
  })

  it('returns only the remaining pending visibility time', () => {
    expect(
      getAutomationRerunPendingRemainingMs({
        pendingStartedAt: 1_000,
        now: 1_250
      })
    ).toBe(AUTOMATION_RERUN_PENDING_MIN_VISIBLE_MS - 250)
  })

  it('does not add delay after the pending visibility window has elapsed', () => {
    expect(
      getAutomationRerunPendingRemainingMs({
        pendingStartedAt: 1_000,
        now: 2_000
      })
    ).toBe(0)
  })
})
