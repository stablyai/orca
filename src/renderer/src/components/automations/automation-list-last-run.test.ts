import { describe, expect, it } from 'vitest'
import type {
  Automation,
  AutomationRun,
  ExternalAutomationJob
} from '../../../../shared/automations-types'
import {
  formatAutomationLastRunCell,
  getExternalAutomationLastRunSnapshot,
  getLocalAutomationLastRunSnapshot,
  getToneForAutomationRunStatus,
  indexLatestAutomationRuns
} from './automation-list-last-run'

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'automation-1',
    name: 'Nightly',
    prompt: 'run',
    precheck: null,
    agentId: 'codex',
    projectId: 'repo-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: 'worktree-1',
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
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
    title: 'Nightly',
    scheduledFor: 10,
    status: 'completed',
    trigger: 'scheduled',
    workspaceId: 'worktree-1',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 20,
    dispatchedAt: 30,
    createdAt: 10,
    ...overrides
  }
}

function makeJob(overrides: Partial<ExternalAutomationJob> = {}): ExternalAutomationJob {
  return {
    id: 'job-1',
    managerId: 'manager-1',
    provider: 'hermes',
    name: 'Digest',
    schedule: '0 9 * * 1-5',
    rawSchedule: null,
    enabled: true,
    state: 'enabled',
    prompt: null,
    promptPreview: '',
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    workdir: null,
    runCount: 0,
    runs: [],
    ...overrides
  }
}

describe('automation-list-last-run', () => {
  it('indexes the newest run per automation', () => {
    const latest = indexLatestAutomationRuns([
      makeRun({ id: 'old', createdAt: 10, dispatchedAt: 10 }),
      makeRun({ id: 'new', createdAt: 50, dispatchedAt: 50, status: 'dispatch_failed' }),
      makeRun({ id: 'other', automationId: 'automation-2', createdAt: 20 })
    ])
    expect(latest.get('automation-1')?.id).toBe('new')
    expect(latest.get('automation-2')?.id).toBe('other')
  })

  it('classifies local run statuses', () => {
    expect(getToneForAutomationRunStatus('dispatch_failed')).toBe('failed')
    expect(getToneForAutomationRunStatus('completed')).toBe('succeeded')
    expect(getToneForAutomationRunStatus('dispatched')).toBe('running')
    expect(getToneForAutomationRunStatus('skipped_precheck')).toBe('skipped')
  })

  it('prefers the latest run over lastRunAt-only metadata', () => {
    const snapshot = getLocalAutomationLastRunSnapshot(
      makeAutomation({ lastRunAt: 5 }),
      makeRun({ status: 'dispatch_failed', dispatchedAt: 40, createdAt: 40 })
    )
    expect(snapshot.tone).toBe('failed')
    expect(snapshot.at).toBe(40)
    expect(snapshot.statusLabel).toBe('Failed')
  })

  it('falls back to lastRunAt when no run history exists', () => {
    const snapshot = getLocalAutomationLastRunSnapshot(makeAutomation({ lastRunAt: 99 }), undefined)
    expect(snapshot).toEqual({ at: 99, tone: 'unknown', statusLabel: '' })
  })

  it('treats missing local history as never run', () => {
    expect(getLocalAutomationLastRunSnapshot(makeAutomation(), undefined).tone).toBe('never')
  })

  it('classifies external last-run status and errors', () => {
    expect(
      getExternalAutomationLastRunSnapshot(
        makeJob({ lastRunAt: '2026-08-12T01:00:00Z', lastStatus: 'failed' })
      )
    ).toMatchObject({ tone: 'failed', statusLabel: 'Failed' })
    expect(
      getExternalAutomationLastRunSnapshot(
        makeJob({ lastRunAt: '2026-08-12T01:00:00Z', lastStatus: 'ok' })
      )
    ).toMatchObject({ tone: 'succeeded', statusLabel: 'Done' })
    expect(
      getExternalAutomationLastRunSnapshot(makeJob({ lastError: 'boom', lastStatus: null }))
    ).toMatchObject({ tone: 'failed', statusLabel: 'Failed' })
    expect(
      getExternalAutomationLastRunSnapshot(
        makeJob({ lastRunAt: '2026-08-12T01:00:00Z', lastStatus: 'ok', lastError: 'stale' })
      )
    ).toMatchObject({ tone: 'succeeded', statusLabel: 'Done' })
    expect(getExternalAutomationLastRunSnapshot(makeJob()).tone).toBe('never')
  })

  it('formats last-run cells as status plus relative time', () => {
    const now = Date.parse('2026-08-12T10:00:00Z')
    const failed = formatAutomationLastRunCell(
      { at: now - 8 * 60 * 60 * 1000, tone: 'failed', statusLabel: 'Failed' },
      now
    )
    expect(failed.text).toBe('Failed 8h ago')
    expect(failed.tone).toBe('failed')
    expect(
      formatAutomationLastRunCell({ at: null, tone: 'never', statusLabel: '' }, now).text
    ).toBe('Never')
    const failedNoTime = formatAutomationLastRunCell(
      { at: null, tone: 'failed', statusLabel: 'Failed' },
      now
    )
    expect(failedNoTime.text).toBe('Failed')
    expect(failedNoTime.tone).toBe('failed')
  })
})
