import { describe, expect, it } from 'vitest'
import { cacheKeyLooksLikeRepo, selectComposerIssueSourceCandidates } from './composer-issue-source'

describe('cacheKeyLooksLikeRepo', () => {
  it('matches plain and host-scoped work-items keys', () => {
    expect(cacheKeyLooksLikeRepo('repo-1::12::', 'repo-1')).toBe(true)
    expect(cacheKeyLooksLikeRepo('ssh:abc::repo-1::12::', 'repo-1')).toBe(true)
    expect(cacheKeyLooksLikeRepo('repo-2::12::', 'repo-1')).toBe(false)
  })
})

describe('selectComposerIssueSourceCandidates', () => {
  it('returns divergent origin/upstream from a matching cache entry', () => {
    const result = selectComposerIssueSourceCandidates(
      {
        'repo-1::12::': {
          sources: {
            issues: { owner: 'up', repo: 'orca' },
            prs: { owner: 'up', repo: 'orca' },
            originCandidate: { owner: 'me', repo: 'orca' },
            upstreamCandidate: { owner: 'stablyai', repo: 'orca' }
          }
        }
      },
      'repo-1'
    )
    expect(result).toEqual({
      origin: { owner: 'me', repo: 'orca' },
      upstream: { owner: 'stablyai', repo: 'orca' }
    })
  })

  it('skips same-slug origin/upstream and missing candidates', () => {
    expect(
      selectComposerIssueSourceCandidates(
        {
          'repo-1::12::': {
            sources: {
              issues: null,
              prs: null,
              originCandidate: { owner: 'me', repo: 'orca' },
              upstreamCandidate: { owner: 'me', repo: 'orca' }
            }
          }
        },
        'repo-1'
      )
    ).toBeNull()

    expect(
      selectComposerIssueSourceCandidates(
        {
          'repo-1::12::': {
            sources: {
              issues: null,
              prs: null,
              originCandidate: { owner: 'me', repo: 'orca' },
              upstreamCandidate: null
            }
          }
        },
        'repo-1'
      )
    ).toBeNull()
  })

  it('finds host-scoped cache keys for the selected repo', () => {
    const result = selectComposerIssueSourceCandidates(
      {
        'ssh:server::repo-1::12::q': {
          sources: {
            issues: { owner: 'up', repo: 'orca' },
            prs: { owner: 'up', repo: 'orca' },
            originCandidate: { owner: 'me', repo: 'orca' },
            upstreamCandidate: { owner: 'up', repo: 'orca' }
          }
        }
      },
      'repo-1'
    )
    expect(result?.upstream.owner).toBe('up')
  })
})
