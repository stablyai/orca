/**
 * These strings used to be bare literals inside the dropdown builder, where the
 * coverage audit cannot see them — it inspects JSX attributes and object
 * properties, not values returned from helpers. Asserting each branch here keeps
 * the copy going through the catalog and pins the English wording.
 */
import { describe, expect, it } from 'vitest'
import { commitSyncTitle, createBlockedHint, rebaseItemCopy } from './source-control-dropdown-copy'
import type { HostedReviewCreationBlockedReason } from '../../../../shared/hosted-review'

const READY = {
  upstreamLoading: false,
  publishBlockedByPRLoading: false,
  publishBlockedByMergedPR: false,
  publishBlockedByDetachedHead: false,
  hasUpstream: true,
  shouldForcePushWithLease: false,
  commitDisabledReason: null
}

describe('commit & sync tooltip', () => {
  it.each([
    [{ upstreamLoading: true }, 'Checking branch status…'],
    [{ publishBlockedByPRLoading: true }, 'Checking PR status…'],
    [{ publishBlockedByMergedPR: true }, 'PR is already merged'],
    [{ publishBlockedByDetachedHead: true }, 'Check out a branch before syncing commits'],
    [{ hasUpstream: false }, 'Publish the branch first to sync commits'],
    [
      { shouldForcePushWithLease: true },
      'Use Commit & Force Push — remote only has older copies of local commits'
    ],
    [{}, 'Commit, then pull and push']
  ])('explains %o as %s', (overrides, expected) => {
    expect(commitSyncTitle({ ...READY, ...overrides })).toBe(expected)
  })

  // Why: a caller-supplied reason is more specific than either default, so it wins.
  it.each([{ shouldForcePushWithLease: true }, {}])(
    'prefers an explicit commit reason over the default',
    (overrides) => {
      expect(
        commitSyncTitle({ ...READY, ...overrides, commitDisabledReason: 'Resolve conflicts first' })
      ).toBe('Resolve conflicts first')
    }
  )
})

describe('rebase entry copy', () => {
  it('names the base branch in both the label and the tooltip', () => {
    expect(
      rebaseItemCopy({
        rebaseBaseLabel: 'origin/main',
        hasRemoteBaseRef: true,
        hasDirtyLocalChanges: false
      })
    ).toEqual({
      label: 'Rebase from origin/main',
      title: 'Rebase current branch with latest commits from origin/main'
    })
  })

  it('asks for a remote base when none is resolved', () => {
    expect(
      rebaseItemCopy({
        rebaseBaseLabel: null,
        hasRemoteBaseRef: false,
        hasDirtyLocalChanges: false
      })
    ).toEqual({
      label: 'Rebase from Base',
      title: 'Choose a remote base branch to rebase from'
    })
  })

  it('warns about local changes while keeping the named label', () => {
    expect(
      rebaseItemCopy({
        rebaseBaseLabel: 'origin/main',
        hasRemoteBaseRef: true,
        hasDirtyLocalChanges: true
      })
    ).toEqual({
      label: 'Rebase from origin/main',
      title: 'Try rebasing; git may require committing or stashing local changes first'
    })
  })
})

describe('blocked review-creation hint', () => {
  const BASE = {
    shouldForcePushWithLease: false,
    upstreamLoading: false,
    authInstruction: 'Run gh auth login',
    reviewLabel: 'pull request'
  }

  it.each<[HostedReviewCreationBlockedReason, string]>([
    ['dirty', 'Commit changes first'],
    ['detached_head', 'Check out a branch first'],
    ['default_branch', 'Switch to a feature branch'],
    ['no_upstream', 'Publish Branch'],
    ['needs_push', 'Push first'],
    ['needs_sync', 'Sync first'],
    ['unsupported_provider', 'Unsupported provider'],
    ['fork_head_unsupported', 'Fork head unsupported'],
    ['base_not_on_remote', 'Base branch is not on the remote'],
    ['auth_required', 'Run gh auth login in this environment'],
    ['existing_review', 'A pull request already exists']
  ])('turns %s into the next step: %s', (blockedReason, expected) => {
    expect(createBlockedHint({ ...BASE, blockedReason })).toBe(expected)
  })

  it('names force push when the branch needs one', () => {
    expect(
      createBlockedHint({ ...BASE, blockedReason: 'needs_sync', shouldForcePushWithLease: true })
    ).toBe('Force Push first')
  })

  it.each<[HostedReviewCreationBlockedReason | undefined, boolean, string]>([
    [null, false, 'Branch is not ready'],
    [undefined, false, 'Branch is not ready'],
    [null, true, 'Checking branch status…']
  ])('falls back for %s while loading=%s', (blockedReason, upstreamLoading, expected) => {
    expect(createBlockedHint({ ...BASE, blockedReason, upstreamLoading })).toBe(expected)
  })
})
