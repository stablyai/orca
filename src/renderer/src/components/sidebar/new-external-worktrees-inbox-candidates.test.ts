import { describe, expect, it } from 'vitest'

import type {
  DetectedWorktree,
  DetectedWorktreeListResult,
  Repo,
  Worktree
} from '../../../../shared/types'
import { buildNewExternalWorktreesInboxCandidates } from './new-external-worktrees-inbox-candidates'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#000000',
  addedAt: Date.UTC(2026, 4, 24),
  externalWorktreeVisibility: 'hide',
  externalWorktreeVisibilityPromptDismissedAt: 1,
  externalWorktreeInboxBaselinePaths: ['/scratch/old-one']
}

const visibleWorktree: Worktree = {
  id: 'repo-1::/repo',
  repoId: repo.id,
  path: '/repo',
  displayName: 'main',
  branch: 'refs/heads/main',
  head: 'abc123',
  isBare: false,
  isMainWorktree: true,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

function detectedWorktree(overrides: Partial<DetectedWorktree> = {}): DetectedWorktree {
  return {
    ...visibleWorktree,
    id: 'repo-1::/scratch/new-one',
    path: '/scratch/new-one',
    displayName: 'new-one',
    isMainWorktree: false,
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

describe('buildNewExternalWorktreesInboxCandidates', () => {
  it('builds inbox candidates only after the initial prompt is dismissed', () => {
    const detectedWorktreesByRepo = {
      [repo.id]: detectedResult([detectedWorktree()])
    }

    expect(
      buildNewExternalWorktreesInboxCandidates({
        repos: [repo],
        visibleWorktrees: [visibleWorktree],
        detectedWorktreesByRepo
      }).get(repo.id)
    ).toMatchObject({
      repo: { id: repo.id },
      inboxWorktrees: [{ id: 'repo-1::/scratch/new-one' }]
    })

    expect(
      buildNewExternalWorktreesInboxCandidates({
        repos: [{ ...repo, externalWorktreeVisibilityPromptDismissedAt: undefined }],
        visibleWorktrees: [visibleWorktree],
        detectedWorktreesByRepo
      }).size
    ).toBe(0)
  })

  it('suppresses inbox candidates when discovery is permanently hidden or visibility is show', () => {
    const detectedWorktreesByRepo = { [repo.id]: detectedResult([detectedWorktree()]) }

    expect(
      buildNewExternalWorktreesInboxCandidates({
        repos: [{ ...repo, externalWorktreeDiscoverySuppressedAt: 1 }],
        detectedWorktreesByRepo
      }).size
    ).toBe(0)
    expect(
      buildNewExternalWorktreesInboxCandidates({
        repos: [{ ...repo, externalWorktreeVisibility: 'show' }],
        detectedWorktreesByRepo
      }).size
    ).toBe(0)
  })
})
