import { describe, expect, it } from 'vitest'
import type {
  Automation,
  AutomationRunStatus,
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations-types'
import {
  EMPTY_AUTOMATION_LIST_FILTER,
  filterAutomationListRows,
  filterExternalAutomationListEntries,
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
    provider: 'openclaw',
    label: 'Local OpenClaw',
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
    provider: 'openclaw',
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

describe('automation-list-view', () => {
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
})
