import { describe, expect, it } from 'vitest'
import {
  resolveCreateReviewDraftTitle,
  resolveCreateReviewSeedText
} from './create-review-draft-title'

describe('resolveCreateReviewDraftTitle', () => {
  it('uses the hosted eligibility title when one is available', () => {
    expect(
      resolveCreateReviewDraftTitle({
        branch: 'feature/improve-diff-view',
        eligibilityTitle: '  Improve diff view  '
      })
    ).toBe('Improve diff view')
  })

  it('falls back when the hosted eligibility title is blank', () => {
    expect(
      resolveCreateReviewDraftTitle({
        branch: 'feature/restore-create-review',
        eligibilityTitle: '   '
      })
    ).toBe('Restore create review')
  })

  it('falls back to a readable title from the branch leaf', () => {
    expect(
      resolveCreateReviewDraftTitle({
        branch: 'refs/heads/feature/improve-diff-view-per-file',
        eligibilityTitle: null
      })
    ).toBe('Improve diff view per file')
  })

  it('normalizes remote refs before deriving the branch leaf', () => {
    expect(
      resolveCreateReviewDraftTitle({
        branch: 'refs/remotes/origin/feature/improve-diff-view-per-file'
      })
    ).toBe('Improve diff view per file')
  })
})

describe('Jira review seed', () => {
  it.each(['github', 'gitlab'] as const)(
    'prefixes %s titles from the canonical Jira source',
    (provider) => {
      expect(
        resolveCreateReviewSeedText({
          branch: 'user/team_alpha9-7-restore-login',
          eligibility: { provider, title: 'Restore login', body: 'Details' },
          jiraIssueKey: 'TEAM_ALPHA9-7'
        })
      ).toEqual({ title: 'TEAM_ALPHA9-7 Restore login', body: 'Details' })
    }
  )
  it('uses the key once when the title comes from an existing lowercase branch', () => {
    expect(
      resolveCreateReviewSeedText({
        branch: 'user/team_alpha9-7-restore-login',
        eligibility: { provider: 'gitlab', title: '', body: '' },
        jiraIssueKey: 'TEAM_ALPHA9-7'
      })
    ).toEqual({ title: 'TEAM_ALPHA9-7 Restore login', body: '' })
  })
})
