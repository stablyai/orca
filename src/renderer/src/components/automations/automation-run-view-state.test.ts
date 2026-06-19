import { describe, expect, it } from 'vitest'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import {
  AUTOMATION_RERUN_PENDING_MIN_VISIBLE_MS,
  canRerunAutomationRun,
  getAutomationRerunPendingRemainingMs,
  getAutomationRunViewState
} from './automation-run-view-state'

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
        terminalTabExists: true
      })
    ).toMatchObject({
      availability: 'terminal',
      actionLabel: 'View run',
      statusLabel: 'Run is open',
      canOpen: true
    })
  })

  it('falls back to resuming the workspace when terminal history is gone', () => {
    expect(
      getAutomationRunViewState({
        run: makeRun(),
        workspaceExists: true,
        terminalTabExists: false
      })
    ).toMatchObject({
      availability: 'workspace',
      actionLabel: 'Resume workspace',
      statusLabel: 'Workspace is available; original terminal is closed.',
      canOpen: true
    })
  })

  it('keeps skipped or missing-workspace runs as metadata-only history', () => {
    expect(
      getAutomationRunViewState({
        run: makeRun({ workspaceId: null, terminalSessionId: null }),
        workspaceExists: false,
        terminalTabExists: false
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
        terminalTabExists: false
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
        terminalTabExists: false
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
