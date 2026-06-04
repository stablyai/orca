import { describe, expect, it } from 'vitest'
import {
  checksPanelAsyncResultKey,
  checksPanelHostedReviewAsyncResultKey,
  shouldCommitChecksPanelAsyncResult
} from './checks-panel-async-result-key'

describe('checksPanelAsyncResultKey', () => {
  it('builds a stable repo-scoped key', () => {
    expect(checksPanelAsyncResultKey('repo-id', 'feature/test', 12)).toBe(
      'repo-id::feature/test::none::12::none'
    )
  })

  it('uses explicit none marker when PR is absent', () => {
    expect(checksPanelAsyncResultKey('repo-id', 'feature/test', null)).toBe(
      'repo-id::feature/test::none::none::none'
    )
  })

  it('normalizes PR repo identity', () => {
    expect(
      checksPanelAsyncResultKey('repo-id', 'feature/test', 12, {
        owner: 'Acme',
        repo: 'Widgets'
      })
    ).toBe('repo-id::feature/test::acme/widgets::12::none')
  })

  it('includes PR head SHA so stale checks cannot commit after a new head is discovered', () => {
    expect(checksPanelAsyncResultKey('repo-id', 'feature/test', 12, null, 'head-a')).toBe(
      'repo-id::feature/test::none::12::head-a'
    )
  })

  it('includes hosted-review provider identity for non-GitHub review results', () => {
    expect(
      checksPanelHostedReviewAsyncResultKey(
        'local::repo-id::feature/test',
        'feature/test',
        'gitlab',
        12,
        'head-a'
      )
    ).toBe('local::repo-id::feature/test::feature/test::gitlab::12::head-a')
  })
})

describe('shouldCommitChecksPanelAsyncResult', () => {
  it('suppresses stale async completions', () => {
    expect(
      shouldCommitChecksPanelAsyncResult(
        checksPanelAsyncResultKey('repo-id', 'feature/new', 99),
        checksPanelAsyncResultKey('repo-id', 'feature/old', 12)
      )
    ).toBe(false)
  })

  it('suppresses stale completions when the PR repo changes without a PR number change', () => {
    expect(
      shouldCommitChecksPanelAsyncResult(
        checksPanelAsyncResultKey('repo-id', 'feature/test', 12, {
          owner: 'upstream',
          repo: 'orca'
        }),
        checksPanelAsyncResultKey('repo-id', 'feature/test', 12, {
          owner: 'fork',
          repo: 'orca'
        })
      )
    ).toBe(false)
  })
})
