import { describe, expect, it } from 'vitest'
import {
  evaluateWorkspaceCleanup,
  keepFolderWorkspaceSiblings,
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

describe('keepFolderWorkspaceSiblings', () => {
  it('keeps a merged worktree while another repo in its folder workspace is still in use', () => {
    const verdicts = keepFolderWorkspaceSiblings([
      {
        worktreeId: 'repo-a::a1',
        folderSiblingIds: ['repo-b::b1'],
        evaluation: { action: 'delete', reason: 'merged' }
      },
      {
        worktreeId: 'repo-b::b1',
        folderSiblingIds: ['repo-a::a1'],
        evaluation: { action: 'keep', cause: 'unpushed-commits', reason: 'merged' }
      }
    ])
    expect(verdicts).toEqual([
      { action: 'keep', cause: 'folder-workspace-sibling', reason: 'merged' },
      { action: 'keep', cause: 'unpushed-commits', reason: 'merged' }
    ])
  })

  it('lets a folder workspace go while one of its worktrees is already being removed', () => {
    const verdicts = keepFolderWorkspaceSiblings([
      {
        worktreeId: 'repo-a::a1',
        folderSiblingIds: ['repo-b::b1'],
        evaluation: { action: 'delete', reason: 'merged' }
      },
      {
        worktreeId: 'repo-b::b1',
        folderSiblingIds: ['repo-a::a1'],
        evaluation: { action: 'keep', cause: 'removing' }
      }
    ])
    expect(verdicts[0]).toEqual({ action: 'delete', reason: 'merged' })
  })
})
