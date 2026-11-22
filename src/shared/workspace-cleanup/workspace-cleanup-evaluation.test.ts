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
})
