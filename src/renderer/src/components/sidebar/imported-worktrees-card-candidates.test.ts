import { describe, expect, it } from 'vitest'

import {
  buildImportedWorktreesCardCandidates,
  getHiddenImportedWorktrees
} from './imported-worktrees-card-candidates'
import type {
  DetectedWorktree,
  DetectedWorktreeListResult,
  Repo,
  Worktree
} from '../../../../shared/types'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#000000',
  addedAt: Date.UTC(2026, 4, 24),
  externalWorktreeVisibility: 'hide'
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
    id: 'repo-1::/repo-worktree',
    path: '/repo-worktree',
    displayName: 'repo-worktree',
    isMainWorktree: false,
    ownership: 'external',
    selectedCheckout: false,
    visible: false,
    ...overrides
  }
}

function detectedResult(
  worktrees: DetectedWorktree[],
  overrides: Partial<DetectedWorktreeListResult> = {}
): DetectedWorktreeListResult {
  return {
    repoId: repo.id,
    authoritative: true,
    source: 'git',
    worktrees,
    ...overrides
  }
}

describe('getHiddenImportedWorktrees', () => {
  it('returns only authoritative hidden external worktrees', () => {
    const hidden = detectedWorktree({ id: 'hidden' })
    const result = getHiddenImportedWorktrees(
      detectedResult([
        hidden,
        detectedWorktree({ id: 'visible', visible: true }),
        detectedWorktree({ id: 'selected', selectedCheckout: true }),
        detectedWorktree({ id: 'orca-managed', ownership: 'orca-managed' })
      ])
    )

    expect(result).toEqual([hidden])
  })

  it('suppresses non-authoritative results', () => {
    expect(
      getHiddenImportedWorktrees(detectedResult([detectedWorktree()], { authoritative: false }))
    ).toEqual([])
  })
})

describe('buildImportedWorktreesCardCandidates', () => {
  it('builds a candidate for hidden imported worktrees in a visible repo', () => {
    const candidates = buildImportedWorktreesCardCandidates({
      repos: [repo],
      visibleWorktrees: [visibleWorktree],
      detectedWorktreesByRepo: { [repo.id]: detectedResult([detectedWorktree()]) }
    })

    expect(candidates.get(repo.id)).toMatchObject({
      repo: { id: repo.id },
      hiddenWorktrees: [{ id: 'repo-1::/repo-worktree' }]
    })
  })

  it('suppresses candidates after show, dismissal, folder repos, or repo filters exclude the repo', () => {
    const detectedWorktreesByRepo = { [repo.id]: detectedResult([detectedWorktree()]) }

    expect(
      buildImportedWorktreesCardCandidates({
        repos: [{ ...repo, externalWorktreeVisibility: 'show' }],
        visibleWorktrees: [visibleWorktree],
        detectedWorktreesByRepo
      }).size
    ).toBe(0)
    expect(
      buildImportedWorktreesCardCandidates({
        repos: [{ ...repo, externalWorktreeVisibilityPromptDismissedAt: 1 }],
        visibleWorktrees: [visibleWorktree],
        detectedWorktreesByRepo
      }).size
    ).toBe(0)
    expect(
      buildImportedWorktreesCardCandidates({
        repos: [{ ...repo, kind: 'folder' }],
        visibleWorktrees: [visibleWorktree],
        detectedWorktreesByRepo
      }).size
    ).toBe(0)
    expect(
      buildImportedWorktreesCardCandidates({
        repos: [repo],
        detectedWorktreesByRepo,
        filterRepoIds: ['other-repo']
      }).size
    ).toBe(0)
  })

  it('keeps candidates visible after a rollback failure forces a shown repo to render the card', () => {
    const candidates = buildImportedWorktreesCardCandidates({
      repos: [{ ...repo, externalWorktreeVisibility: 'show' }],
      visibleWorktrees: [visibleWorktree],
      detectedWorktreesByRepo: { [repo.id]: detectedResult([detectedWorktree()]) },
      forceVisibleRepoIds: new Set([repo.id])
    })

    expect(candidates.get(repo.id)).toMatchObject({
      repo: { id: repo.id },
      hiddenWorktrees: [{ id: 'repo-1::/repo-worktree' }]
    })
  })

  it('builds candidates even when workspace-row filters hide every visible worktree', () => {
    const candidates = buildImportedWorktreesCardCandidates({
      repos: [repo],
      detectedWorktreesByRepo: { [repo.id]: detectedResult([detectedWorktree()]) }
    })

    expect(candidates.has(repo.id)).toBe(true)
  })
})
