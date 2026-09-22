import { describe, expect, it } from 'vitest'
import type {
  Automation,
  AutomationRunStatus,
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations-types'
import {
  applyAutomationListView,
  countAutomationListFilters,
  EMPTY_AUTOMATION_LIST_FILTER,
  filterAutomationListRows,
  filterExternalAutomationListEntries,
  isAutomationListFilterActive,
  nextAutomationListSort,
  type AutomationListFilter
} from './automation-list-view'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import type { AutomationListRow } from './automation-list-row-identity'
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
  return {
    key: `${manager.id}:${job.id}`,
    scope: {
      owner: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
      provider: manager.provider
    },
    manager,
    job
  }
}

/** A catalog row with an optional projected last-run status, keyed like a real host row. */
function makeCatalogRow(
  id: string,
  overrides: Partial<Automation> = {},
  lastRunStatus?: AutomationRunStatus
): AutomationListRow {
  return {
    key: `row|host|${id}`,
    automation: makeAutomation({ id, ...overrides }),
    hostLabel: 'This computer',
    usageSummary: lastRunStatus
      ? {
          knownRuns: 1,
          unavailableRuns: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: null,
          lastRunStatus,
          lastRunAt: 111
        }
      : null
  }
}

const rowKey = (id: string): string => `row|host|${id}`

describe('automation-list-view', () => {
  it('counts and detects active filters', () => {
    expect(
      isAutomationListFilterActive({
        status: 'all',
        lastRun: 'all',
        agentIds: []
      })
    ).toBe(false)
    expect(
      isAutomationListFilterActive({
        status: 'paused',
        lastRun: 'all',
        agentIds: []
      })
    ).toBe(true)
    expect(
      countAutomationListFilters({
        status: 'paused',
        lastRun: 'failed',
        agentIds: []
      })
    ).toBe(2)
  })

  it('toggles sort direction and defaults last run to newest first', () => {
    expect(nextAutomationListSort(null, 'name')).toEqual({
      field: 'name',
      direction: 'asc'
    })
    expect(nextAutomationListSort(null, 'lastRun')).toEqual({
      field: 'lastRun',
      direction: 'desc'
    })
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
      rows: [
        makeCatalogRow('paused', { name: 'Paused', enabled: false }, 'completed'),
        makeCatalogRow('ok', { name: 'Healthy' }, 'dispatch_failed')
      ],
      externalEntries: [makeExternalEntry()],
      filter: { status: 'enabled', lastRun: 'failed', agentIds: [] },
      sort: null,
      locale: 'en'
    })
    expect(items.map((item) => item.id)).toEqual([rowKey('ok'), 'manager-1:job-1'])
  })

  it('filters local rows by multiple agents and leaves external rows out of agent scopes', () => {
    const items = applyAutomationListView({
      rows: [
        makeCatalogRow('codex-job', { agentId: 'codex' }),
        makeCatalogRow('claude-job', { agentId: 'claude' })
      ],
      externalEntries: [makeExternalEntry()],
      filter: { status: 'all', lastRun: 'all', agentIds: ['codex', 'claude'] },
      sort: null,
      locale: 'en'
    })

    expect(items.map((item) => item.id)).toEqual([rowKey('codex-job'), rowKey('claude-job')])
  })

  it('counts an agent filter alongside status and last-run filters', () => {
    expect(
      isAutomationListFilterActive({
        status: 'all',
        lastRun: 'all',
        agentIds: []
      })
    ).toBe(false)
    expect(
      countAutomationListFilters({
        status: 'paused',
        lastRun: 'failed',
        agentIds: ['codex']
      })
    ).toBe(3)
  })

  it('sorts by name across local and external rows', () => {
    const items = applyAutomationListView({
      rows: [makeCatalogRow('zebra', { name: 'Zebra job' })],
      externalEntries: [makeExternalEntry({ name: 'Alpha digest' })],
      filter: { status: 'all', lastRun: 'all', agentIds: [] },
      sort: { field: 'name', direction: 'asc' },
      locale: 'en'
    })
    expect(items.map((item) => item.name)).toEqual(['Alpha digest', 'Zebra job'])
  })

  it('filters catalog rows by status, agent, and the projected last-run status', () => {
    const rows = [
      makeCatalogRow('paused-codex', { enabled: false, agentId: 'codex' }),
      makeCatalogRow('failed-claude', { agentId: 'claude' }, 'dispatch_failed'),
      makeCatalogRow('succeeded-codex', { agentId: 'codex' }, 'completed'),
      makeCatalogRow('never-codex', { agentId: 'codex' })
    ]
    const ids = (filter: Partial<AutomationListFilter>) =>
      filterAutomationListRows(rows, {
        ...EMPTY_AUTOMATION_LIST_FILTER,
        ...filter
      }).map((row) => row.automation.id)

    expect(ids({ status: 'paused' })).toEqual(['paused-codex'])
    expect(ids({ agentIds: ['claude'] })).toEqual(['failed-claude'])
    expect(ids({ lastRun: 'failed' })).toEqual(['failed-claude'])
    expect(ids({ lastRun: 'succeeded' })).toEqual(['succeeded-codex'])
    expect(ids({ lastRun: 'never' })).toEqual(['paused-codex', 'never-codex'])
    // Inactive filter keeps the input identity so nothing re-renders for it.
    expect(filterAutomationListRows(rows, EMPTY_AUTOMATION_LIST_FILTER)).toBe(rows)
  })

  it('narrows rows to any of the selected hosts and drops pre-catalog rows', () => {
    const hostRow = (id: string, targetId: string | null): AutomationListRow => ({
      key: `row|${targetId ?? 'unscoped'}|${id}`,
      automation: makeAutomation({ id }),
      catalogRef:
        targetId === null
          ? null
          : {
              authority: { kind: 'desktop' },
              selector: { kind: 'ssh', targetId }
            },
      hostLabel: targetId ?? '',
      usageSummary: null
    })
    const rows = [hostRow('on-a', 'ssh-a'), hostRow('on-b', 'ssh-b'), hostRow('legacy', null)]
    const keyOf = (row: AutomationListRow): string =>
      row.catalogRef ? hostStableKey(row.catalogRef) : ''
    const ids = (hostStableKeys: readonly string[]) =>
      filterAutomationListRows(rows, {
        ...EMPTY_AUTOMATION_LIST_FILTER,
        hostStableKeys
      }).map((row) => row.automation.id)

    // Multi-select is any-of; a pre-catalog row names no host and is excluded.
    expect(ids([keyOf(rows[0]), keyOf(rows[1])])).toEqual(['on-a', 'on-b'])
    expect(ids([keyOf(rows[1])])).toEqual(['on-b'])
  })

  it('excludes external jobs from any agent filter and honors their status', () => {
    const entries = [makeExternalEntry({ enabled: false, state: 'disabled' })]
    expect(
      filterExternalAutomationListEntries(entries, {
        ...EMPTY_AUTOMATION_LIST_FILTER,
        agentIds: ['codex']
      })
    ).toEqual([])
    expect(
      filterExternalAutomationListEntries(entries, {
        ...EMPTY_AUTOMATION_LIST_FILTER,
        status: 'paused'
      })
    ).toHaveLength(1)
    expect(
      filterExternalAutomationListEntries(entries, {
        ...EMPTY_AUTOMATION_LIST_FILTER,
        status: 'enabled'
      })
    ).toEqual([])
  })

  it('sorts by last run newest first and keeps never-run rows last', () => {
    const items = applyAutomationListView({
      rows: [
        makeCatalogRow('old', {
          name: 'Old',
          lastRunAt: Date.parse('2026-08-11T09:00:00Z')
        }),
        makeCatalogRow('never', { name: 'Never' })
      ],
      externalEntries: [makeExternalEntry({ lastRunAt: '2026-08-12T09:00:00Z' })],
      filter: { status: 'all', lastRun: 'all', agentIds: [] },
      sort: { field: 'lastRun', direction: 'desc' },
      locale: 'en'
    })
    expect(items.map((item) => item.id)).toEqual([
      'manager-1:job-1',
      rowKey('old'),
      rowKey('never')
    ])
  })
})
