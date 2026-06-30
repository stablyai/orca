import { describe, expect, it } from 'vitest'

import type { DetectedWorktree, DetectedWorktreeListResult, Repo } from './types'
import {
  getHiddenExternalWorktrees,
  getNewExternalWorktreeInboxWorktrees,
  mergeExternalWorktreeInboxPaths,
  shouldOfferNewExternalWorktreeInbox
} from './external-worktree-inbox'
import { EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT } from './worktree-ownership'

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
  it('merges inbox paths without duplicates when paths match after normalization', () => {
    expect(mergeExternalWorktreeInboxPaths(['/repo/one/'], ['/repo/one', '/repo/two'])).toEqual([
      '/repo/one/',
      '/repo/two'
    ])
  })

  it('offers the inbox only after the initial prompt is dismissed and discovery is not suppressed', () => {
    expect(shouldOfferNewExternalWorktreeInbox(repo)).toBe(true)
    expect(
      shouldOfferNewExternalWorktreeInbox({
        ...repo,
        externalWorktreeVisibilityPromptDismissedAt: undefined
      })
    ).toBe(false)
    expect(
      shouldOfferNewExternalWorktreeInbox({
        ...repo,
        externalWorktreeDiscoverySuppressedAt: 1
      })
    ).toBe(false)
    expect(
      shouldOfferNewExternalWorktreeInbox({
        ...repo,
        externalWorktreeVisibility: 'show'
      })
    ).toBe(false)
  })

  it('returns only hidden external worktrees outside the inbox baseline', () => {
    const hidden = detectedWorktree({ id: 'hidden', path: '/scratch/new-one' })
    const baselined = detectedWorktree({ id: 'baselined', path: '/scratch/old-one' })
    const detected = detectedResult([
      hidden,
      baselined,
      detectedWorktree({ id: 'visible', visible: true }),
      detectedWorktree({ id: 'orca-managed', ownership: 'orca-managed' })
    ])

    expect(getHiddenExternalWorktrees(detected)).toEqual([hidden, baselined])
    expect(
      getNewExternalWorktreeInboxWorktrees(detected, {
        ...repo,
        externalWorktreeInboxBaselinePaths: ['/scratch/old-one']
      })
    ).toEqual([hidden])
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
