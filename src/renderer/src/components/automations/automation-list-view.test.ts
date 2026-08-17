import { describe, expect, it } from 'vitest'
import type {
  Automation,
  AutomationRun,
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations-types'
import {
  applyAutomationListView,
  countAutomationListFilters,
  isAutomationListFilterActive,
  nextAutomationListSort
} from './automation-list-view'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'automation-1',
    name: 'Zebra job',
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
    title: 'Zebra job',
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

function makeExternalEntry(
  overrides: Partial<ExternalAutomationJob> = {}
): ExternalAutomationListEntry {
  const manager: ExternalAutomationManager = {
    id: 'manager-1',
    provider: 'hermes',
    label: 'Local Hermes',
    targetLabel: 'Local',
    target: { type: 'local' },
    status: 'available',
    error: null,
    canManage: true,
    jobs: []
  }
  const job: ExternalAutomationJob = {
    id: 'job-1',
    managerId: manager.id,
    provider: 'hermes',
    name: 'Alpha digest',
    schedule: '0 9 * * 1-5',
    rawSchedule: null,
    enabled: true,
    state: 'enabled',
    prompt: null,
    promptPreview: '',
    nextRunAt: null,
    lastRunAt: '2026-08-12T01:00:00Z',
    lastStatus: 'failed',
    lastError: null,
    workdir: null,
    runCount: 1,
    runs: [],
    ...overrides
  }
  return { key: `${manager.id}:${job.id}`, manager, job }
}

describe('automation-list-view', () => {
  it('counts and detects active filters', () => {
    expect(isAutomationListFilterActive({ status: 'all', lastRun: 'all' })).toBe(false)
    expect(isAutomationListFilterActive({ status: 'paused', lastRun: 'all' })).toBe(true)
    expect(countAutomationListFilters({ status: 'paused', lastRun: 'failed' })).toBe(2)
  })

  it('toggles sort direction and defaults last run to newest first', () => {
    expect(nextAutomationListSort(null, 'name')).toEqual({ field: 'name', direction: 'asc' })
    expect(nextAutomationListSort(null, 'lastRun')).toEqual({ field: 'lastRun', direction: 'desc' })
    expect(nextAutomationListSort({ field: 'name', direction: 'asc' }, 'name')).toEqual({
      field: 'name',
      direction: 'desc'
    })
    expect(nextAutomationListSort({ field: 'name', direction: 'asc' }, 'lastRun')).toEqual({
      field: 'lastRun',
      direction: 'desc'
    })
  })

  it('filters by enabled state and last-run outcome', () => {
    const items = applyAutomationListView({
      automations: [
        makeAutomation({ id: 'paused', name: 'Paused', enabled: false }),
        makeAutomation({ id: 'ok', name: 'Healthy' })
      ],
      externalEntries: [makeExternalEntry()],
      runs: [
        makeRun({ automationId: 'paused', status: 'completed' }),
        makeRun({ automationId: 'ok', status: 'dispatch_failed' })
      ],
      filter: { status: 'enabled', lastRun: 'failed' },
      sort: null
    })
    expect(items.map((item) => item.id)).toEqual(['ok', 'manager-1:job-1'])
  })

  it('sorts by name across local and external rows', () => {
    const items = applyAutomationListView({
      automations: [makeAutomation({ name: 'Zebra job' })],
      externalEntries: [makeExternalEntry({ name: 'Alpha digest' })],
      runs: [],
      filter: { status: 'all', lastRun: 'all' },
      sort: { field: 'name', direction: 'asc' }
    })
    expect(items.map((item) => item.name)).toEqual(['Alpha digest', 'Zebra job'])
  })

  it('sorts by last run newest first and keeps never-run rows last', () => {
    const items = applyAutomationListView({
      automations: [
        makeAutomation({ id: 'old', name: 'Old' }),
        makeAutomation({ id: 'never', name: 'Never' })
      ],
      externalEntries: [makeExternalEntry({ lastRunAt: '2026-08-12T09:00:00Z' })],
      runs: [makeRun({ automationId: 'old', dispatchedAt: Date.parse('2026-08-11T09:00:00Z') })],
      filter: { status: 'all', lastRun: 'all' },
      sort: { field: 'lastRun', direction: 'desc' }
    })
    expect(items.map((item) => item.id)).toEqual(['manager-1:job-1', 'old', 'never'])
  })
})
