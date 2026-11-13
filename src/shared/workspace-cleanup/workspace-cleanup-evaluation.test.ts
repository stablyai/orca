import { describe, expect, it } from 'vitest'
import {
  evaluateWorkspaceCleanup,
  type WorkspaceCleanupEvaluationInput
} from './workspace-cleanup-evaluation'
import type { ResolvedWorkspaceCleanupPolicy } from './workspace-cleanup-policy'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 12)

function policy(
  rules: Partial<ResolvedWorkspaceCleanupPolicy['rules']>,
  inactiveActionSupported = true
): ResolvedWorkspaceCleanupPolicy {
  return {
    source: 'global',
    inactiveActionSupported,
    rules: {
      merged: { enabled: false },
      unchanged: { enabled: false, afterDays: 1 },
      inactive: { enabled: false, afterDays: 30, action: 'delete' },
      automationRuns: { enabled: false },
      orchestrationWorkers: { enabled: false },
      keepWhen: 'any-local-files',
      ...rules
    }
  }
}

function workspace(
  overrides: Partial<WorkspaceCleanupEvaluationInput> = {}
): WorkspaceCleanupEvaluationInput {
  return {
    reasons: [],
    blockers: [],
    lastActivityAt: NOW - 2 * DAY,
    git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: NOW },
    ...overrides
  }
}

const MERGED_ON = policy({ merged: { enabled: true } })

describe('evaluateWorkspaceCleanup', () => {
  it('deletes a clean merged workspace and keeps it once anything local is at risk', () => {
    const merged = workspace({ reasons: ['merged'] })
    expect(evaluateWorkspaceCleanup(merged, MERGED_ON, NOW)).toEqual({
      action: 'delete',
      reason: 'merged'
    })
    expect(
      evaluateWorkspaceCleanup({ ...merged, blockers: ['dirty-files'] }, MERGED_ON, NOW)
    ).toEqual({ action: 'keep', cause: 'uncommitted-changes', reason: 'merged' })
    expect(
      evaluateWorkspaceCleanup({ ...merged, blockers: ['running-terminal'] }, MERGED_ON, NOW)
    ).toEqual({ action: 'keep', cause: 'terminal-running', reason: 'merged' })
  })

  it('keeps a merged workspace whose git status was never read', () => {
    const unread = workspace({
      reasons: ['merged'],
      git: { clean: null, upstreamAhead: null, upstreamBehind: null, checkedAt: null }
    })
    expect(evaluateWorkspaceCleanup(unread, MERGED_ON, NOW)).toEqual({
      action: 'keep',
      cause: 'git-unknown',
      reason: 'merged'
    })
  })

  it('counts ignored files as local work only when keepWhen asks for it', () => {
    const withEnv = workspace({ reasons: ['merged'], blockers: ['ignored-files'] })
    expect(evaluateWorkspaceCleanup(withEnv, MERGED_ON, NOW)).toMatchObject({
      action: 'keep',
      cause: 'ignored-files'
    })
    expect(
      evaluateWorkspaceCleanup(
        withEnv,
        policy({ merged: { enabled: true }, keepWhen: 'uncommitted' }),
        NOW
      )
    ).toEqual({ action: 'delete', reason: 'merged' })
  })

  it('reports how far a time rule has counted before it fires', () => {
    const inactive = policy({ inactive: { enabled: true, afterDays: 30, action: 'delete' } })
    expect(
      evaluateWorkspaceCleanup(workspace({ lastActivityAt: NOW - 12.5 * DAY }), inactive, NOW)
    ).toEqual({ action: 'keep', cause: 'waiting', waiting: { elapsedDays: 12, afterDays: 30 } })
    expect(
      evaluateWorkspaceCleanup(workspace({ lastActivityAt: NOW - 31 * DAY }), inactive, NOW)
    ).toEqual({ action: 'delete', reason: 'inactive' })
  })

  it('keeps an inactive workspace set to archive while archiving is unavailable', () => {
    const archive = policy({ inactive: { enabled: true, afterDays: 30, action: 'archive' } }, false)
    expect(
      evaluateWorkspaceCleanup(workspace({ lastActivityAt: NOW - 40 * DAY }), archive, NOW)
    ).toEqual({ action: 'keep', cause: 'archive-unavailable', reason: 'inactive' })
  })

  it('keeps pinned, just-touched and opted-out workspaces before any rule fires', () => {
    const merged = workspace({ reasons: ['merged'] })
    expect(evaluateWorkspaceCleanup({ ...merged, blockers: ['pinned'] }, MERGED_ON, NOW)).toEqual({
      action: 'keep',
      cause: 'pinned'
    })
    expect(
      evaluateWorkspaceCleanup({ ...merged, lastActivityAt: NOW - 10 * 60 * 1000 }, MERGED_ON, NOW)
    ).toEqual({ action: 'keep', cause: 'recently-active', reason: 'merged' })
    expect(evaluateWorkspaceCleanup(merged, { ...MERGED_ON, source: 'project-off' }, NOW)).toEqual({
      action: 'keep',
      cause: 'project-off'
    })
  })
})
