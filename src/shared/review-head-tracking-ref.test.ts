import { describe, expect, it } from 'vitest'
import {
  githubPullRequestHeadLocalRef,
  gitlabMergeRequestHeadLocalRef,
  isGithubPullRequestHeadLocalRefForNumber,
  isGitlabMergeRequestHeadLocalRefForNumber,
  reviewHeadRemoteRefComponent,
  selectReviewHeadLocalRefsToPrune
} from './review-head-tracking-ref'

describe('reviewHeadRemoteRefComponent', () => {
  it('is deterministic for the same remote identity', () => {
    const a = reviewHeadRemoteRefComponent('origin', 'git@github.com:org/repo.git')
    const b = reviewHeadRemoteRefComponent('origin', 'git@github.com:org/repo.git')
    expect(a).toBe(b)
    expect(a).toMatch(/^origin-[0-9a-f]{16}$/)
  })

  it('separates same-named remotes pointing at different projects', () => {
    // Why: this is the soft-keep identity guarantee — PR #42 of a repointed
    // origin must never resolve to another project's pinned head.
    const a = reviewHeadRemoteRefComponent('origin', 'git@github.com:org/repo.git')
    const b = reviewHeadRemoteRefComponent('origin', 'git@github.com:other/repo.git')
    expect(a).not.toBe(b)
  })

  it('sanitizes remote names into valid ref components', () => {
    const component = reviewHeadRemoteRefComponent('weird remote/..name', 'https://example.com/r')
    expect(component).toMatch(/^[A-Za-z0-9_-]+-[0-9a-f]{16}$/)
    expect(reviewHeadRemoteRefComponent('...', 'https://example.com/r')).toMatch(
      /^remote-[0-9a-f]{16}$/
    )
  })

  it('builds provider refs under the orca namespace', () => {
    const component = reviewHeadRemoteRefComponent('origin', 'git@github.com:org/repo.git')
    expect(githubPullRequestHeadLocalRef(component, 42)).toBe(`refs/orca/pull/${component}/42`)
    expect(gitlabMergeRequestHeadLocalRef(component, 77)).toBe(
      `refs/orca/merge-requests/${component}/77`
    )
  })
})

describe('review-head ref prune matching (#10431)', () => {
  it('matches PR/MR refs by trailing number only', () => {
    expect(isGithubPullRequestHeadLocalRefForNumber('refs/orca/pull/origin-abc/42', 42)).toBe(true)
    expect(isGithubPullRequestHeadLocalRefForNumber('refs/orca/pull/origin-abc/420', 42)).toBe(
      false
    )
    expect(
      isGitlabMergeRequestHeadLocalRefForNumber('refs/orca/merge-requests/origin-abc/15', 15)
    ).toBe(true)
    expect(isGitlabMergeRequestHeadLocalRefForNumber('refs/orca/pull/origin-abc/15', 15)).toBe(
      false
    )
  })

  it('selects only the requested PR/MR refs', () => {
    expect(
      selectReviewHeadLocalRefsToPrune(
        [
          'refs/orca/pull/a/42',
          'refs/orca/pull/b/42',
          'refs/orca/pull/a/7',
          'refs/orca/merge-requests/a/42'
        ],
        { githubPrNumber: 42 }
      )
    ).toEqual(['refs/orca/pull/a/42', 'refs/orca/pull/b/42'])
  })
})
