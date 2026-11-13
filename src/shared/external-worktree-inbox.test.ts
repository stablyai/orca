import { describe, expect, it } from 'vitest'

import type { Repo } from './repo-types'
import type { DetectedWorktree, DetectedWorktreeListResult } from './worktree/types'
import {
  getHiddenExternalWorktrees,
  getHiddenImportableExternalWorktrees,
  getNewExternalWorktreeInboxWorktrees
} from './external-worktree-inbox'
import './worktree/visibility/ownership'
import { EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT } from './external-worktree-visibility'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#000000',
  addedAt: Date.UTC(2026, 4, 24),
  externalWorktreeVisibility: 'hide',
  externalWorktreeVisibilityPromptDismissedAt: 1
}

function detectedWorktree(overrides: Partial<DetectedWorktree> = {}): DetectedWorktree {
  return {
    id: 'repo-1::/repo-worktree',
    repoId: repo.id,
    path: '/repo-worktree',
    displayName: 'repo-worktree',
    branch: 'refs/heads/feature',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ownership: 'external',
    selectedCheckout: false,
    visible: false,
    ...overrides
  }
}

function detectedResult(worktrees: DetectedWorktree[]): DetectedWorktreeListResult {
  return {
    repoId: repo.id,
    authoritative: true,
    source: 'git',
    worktrees
  }
}

describe('external worktree inbox', () => {
  it('never offers a branchless Git record for adoption', () => {
    const result = detectedResult([detectedWorktree({ branch: '' })])
    expect(getHiddenExternalWorktrees(result)).toEqual([])
    expect(getHiddenImportableExternalWorktrees(result)).toEqual([])
    expect(getNewExternalWorktreeInboxWorktrees(result, repo)).toEqual([])
  })
  it('lists hidden agent scratch among importable worktrees so recovery stays reachable', () => {
    // Scratch cannot be revealed by the visibility toggle (#9388); per-path import preserves recovery (#10324).
    const hiddenScratch = detectedWorktree({
      id: 'hidden-scratch',
      path: '/repo/.claude/worktrees/scratch-1',
      ownership: 'agent-scratch'
    })
    const hiddenExternal = detectedWorktree({ id: 'hidden-external' })
    const detected = detectedResult([
      hiddenScratch,
      hiddenExternal,
      detectedWorktree({ id: 'visible-scratch', ownership: 'agent-scratch', visible: true }),
      detectedWorktree({ id: 'orca-managed', ownership: 'orca-managed' }),
      detectedWorktree({ id: 'checked-out', selectedCheckout: true }),
      detectedWorktree({ id: 'bare-storage', isBare: true })
    ])

    expect(getHiddenImportableExternalWorktrees(detected)).toEqual([hiddenScratch, hiddenExternal])
    // Scratch remains outside discovery counts despite dialog control.
    expect(getHiddenExternalWorktrees(detected)).toEqual([hiddenExternal])
  })

  it('offers no importable worktrees from a non-authoritative snapshot', () => {
    const scratch = detectedWorktree({ id: 'scratch', ownership: 'agent-scratch' })

    expect(
      getHiddenImportableExternalWorktrees({ ...detectedResult([scratch]), authoritative: false })
    ).toEqual([])
    expect(getHiddenImportableExternalWorktrees(undefined)).toEqual([])
  })

  it('suppresses non-authoritative detected results', () => {
    expect(
      getNewExternalWorktreeInboxWorktrees(detectedResult([detectedWorktree()]), {
        ...repo,
        addedAt: EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT + 1
      })
    ).toEqual([detectedWorktree()])
    expect(
      getNewExternalWorktreeInboxWorktrees(
        { ...detectedResult([detectedWorktree()]), authoritative: false },
        repo
      )
    ).toEqual([])
  })
})
