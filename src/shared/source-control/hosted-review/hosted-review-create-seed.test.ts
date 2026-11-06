import { describe, expect, it } from 'vitest'
import { resolveCreateReviewSeedFromCommits } from './hosted-review-create-seed'

const github = { provider: 'github' as const, title: '', body: '' }

describe('resolveCreateReviewSeedFromCommits', () => {
  it('uses the only commit for both title and description, as GitHub does', () => {
    expect(
      resolveCreateReviewSeedFromCommits({
        branch: 'kelvin/fix-sync',
        eligibility: github,
        commits: [
          { subject: 'fix(git): keep the PR panel in sync', body: 'Refetch after a force push.' }
        ]
      })
    ).toEqual({
      title: 'fix(git): keep the PR panel in sync',
      body: 'Refetch after a force push.'
    })
  })

  it('titles several commits from the branch and lists their subjects oldest first', () => {
    expect(
      resolveCreateReviewSeedFromCommits({
        branch: 'refs/heads/kelvin/mobile-redesign',
        eligibility: github,
        commits: [{ subject: 'feat: add ListRow' }, { subject: 'feat: rebuild Tasks' }]
      })
    ).toEqual({ title: 'Mobile redesign', body: '- feat: add ListRow\n- feat: rebuild Tasks' })
  })

  it('keeps a title and description the host already supplied', () => {
    expect(
      resolveCreateReviewSeedFromCommits({
        branch: 'kelvin/x',
        eligibility: { provider: 'github', title: 'Host title', body: 'Host body' },
        commits: [{ subject: 'one', body: 'commit body' }]
      })
    ).toEqual({ title: 'Host title', body: 'Host body' })
  })

  it('falls back to the branch seed when no commits are known', () => {
    expect(
      resolveCreateReviewSeedFromCommits({
        branch: 'kelvin/add-thing',
        eligibility: github,
        commits: []
      })
    ).toEqual({ title: 'Add thing', body: '' })
  })
})
