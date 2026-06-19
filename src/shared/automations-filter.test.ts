import { describe, expect, it } from 'vitest'
import type { Automation, AutomationRunStatus } from './automations-types'
import {
  classifyAutomationLastRun,
  filterAutomations,
  matchesAutomationFolder,
  matchesAutomationLastRun,
  matchesAutomationSearch,
  matchesAutomationStatus
} from './automations-filter'

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'Nightly release',
    prompt: 'Cut a release build',
    precheck: null,
    agentId: 'claude',
    folderId: null,
    projectId: 'repo-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 0,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('matchesAutomationStatus', () => {
  it('matches everything when status is all', () => {
    expect(matchesAutomationStatus(makeAutomation({ enabled: false }), 'all')).toBe(true)
  })

  it('separates enabled from paused', () => {
    expect(matchesAutomationStatus(makeAutomation({ enabled: true }), 'enabled')).toBe(true)
    expect(matchesAutomationStatus(makeAutomation({ enabled: true }), 'paused')).toBe(false)
    expect(matchesAutomationStatus(makeAutomation({ enabled: false }), 'paused')).toBe(true)
  })
})

describe('matchesAutomationFolder', () => {
  it('treats null filter as the unfiled bucket', () => {
    expect(matchesAutomationFolder(makeAutomation({ folderId: null }), null)).toBe(true)
    expect(matchesAutomationFolder(makeAutomation({ folderId: 'f1' }), null)).toBe(false)
  })

  it('matches a specific folder id', () => {
    expect(matchesAutomationFolder(makeAutomation({ folderId: 'f1' }), 'f1')).toBe(true)
    expect(matchesAutomationFolder(makeAutomation({ folderId: 'f2' }), 'f1')).toBe(false)
  })

  it('treats a legacy automation without folderId as unfiled', () => {
    const legacy = makeAutomation()
    delete (legacy as { folderId?: unknown }).folderId
    expect(matchesAutomationFolder(legacy, null)).toBe(true)
  })
})

describe('matchesAutomationSearch', () => {
  it('returns all when the query is blank', () => {
    expect(matchesAutomationSearch(makeAutomation(), '   ')).toBe(true)
  })

  it('matches case-insensitively over name and prompt', () => {
    const automation = makeAutomation({ name: 'Deploy', prompt: 'Run the SMOKE tests' })
    expect(matchesAutomationSearch(automation, 'deploy')).toBe(true)
    expect(matchesAutomationSearch(automation, 'smoke')).toBe(true)
    expect(matchesAutomationSearch(automation, 'nope')).toBe(false)
  })
})

describe('classifyAutomationLastRun', () => {
  it('buckets terminal statuses and ignores in-flight ones', () => {
    const cases: [AutomationRunStatus, ReturnType<typeof classifyAutomationLastRun>][] = [
      ['completed', 'completed'],
      ['dispatch_failed', 'failed'],
      ['skipped_precheck', 'skipped'],
      ['skipped_missed', 'skipped'],
      ['skipped_unavailable', 'skipped'],
      ['skipped_needs_interactive_auth', 'skipped'],
      ['pending', null],
      ['dispatching', null],
      ['dispatched', null]
    ]
    for (const [status, expected] of cases) {
      expect(classifyAutomationLastRun(status)).toBe(expected)
    }
  })
})

describe('matchesAutomationLastRun', () => {
  it('matches any regardless of history', () => {
    expect(matchesAutomationLastRun(makeAutomation(), 'any', {})).toBe(true)
  })

  it('requires a known run for non-any buckets', () => {
    expect(matchesAutomationLastRun(makeAutomation({ id: 'a1' }), 'failed', {})).toBe(false)
    expect(
      matchesAutomationLastRun(makeAutomation({ id: 'a1' }), 'failed', { a1: 'dispatch_failed' })
    ).toBe(true)
    expect(
      matchesAutomationLastRun(makeAutomation({ id: 'a1' }), 'completed', { a1: 'dispatch_failed' })
    ).toBe(false)
  })
})

describe('filterAutomations', () => {
  const enabledInF1 = makeAutomation({ id: 'a1', name: 'Build', folderId: 'f1', enabled: true })
  const pausedUnfiled = makeAutomation({
    id: 'a2',
    name: 'Cleanup',
    folderId: null,
    enabled: false
  })
  const enabledUnfiled = makeAutomation({
    id: 'a3',
    name: 'Report',
    prompt: 'send weekly report',
    folderId: null,
    enabled: true
  })
  const all = [enabledInF1, pausedUnfiled, enabledUnfiled]

  it('returns everything for empty criteria', () => {
    expect(filterAutomations(all, {})).toEqual(all)
  })

  it('ANDs status and folder', () => {
    expect(filterAutomations(all, { status: 'enabled', folderId: null })).toEqual([enabledUnfiled])
  })

  it('ANDs search with last-run', () => {
    const result = filterAutomations(
      all,
      { search: 'report', lastRun: 'completed' },
      { a3: 'completed' }
    )
    expect(result).toEqual([enabledUnfiled])
    expect(
      filterAutomations(all, { search: 'report', lastRun: 'failed' }, { a3: 'completed' })
    ).toEqual([])
  })
})
