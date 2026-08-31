import { describe, expect, it } from 'vitest'
import type { TaskPageRepoSourceState } from '@/components/task-page-cache-selectors'
import { hasDivergentSources, hasUpstreamCandidateDivergence } from './repo-source-divergence'

function state(
  sources: Partial<NonNullable<TaskPageRepoSourceState['sources']>>
): TaskPageRepoSourceState {
  return {
    repoId: 'repo-1',
    repoPath: '/tmp/repo',
    sourceKey: 'repo-1',
    sources: {
      issues: null,
      prs: null,
      originCandidate: null,
      upstreamCandidate: null,
      ...sources
    },
    error: null
  }
}

describe('hasDivergentSources', () => {
  it('is true when issues and PRs point at different owner/repos', () => {
    expect(
      hasDivergentSources(
        state({
          issues: { owner: 'acme', repo: 'fork', host: 'github.com' },
          prs: { owner: 'acme', repo: 'orca', host: 'github.com' }
        })
      )
    ).toBe(true)
  })

  it('is false when the PR source is missing', () => {
    expect(
      hasDivergentSources(
        state({
          issues: { owner: 'acme', repo: 'fork', host: 'github.com' },
          prs: null
        })
      )
    ).toBe(false)
  })

  it('is false when issues and PRs share an owner/repo', () => {
    expect(
      hasDivergentSources(
        state({
          issues: { owner: 'acme', repo: 'orca', host: 'github.com' },
          prs: { owner: 'acme', repo: 'orca', host: 'github.com' }
        })
      )
    ).toBe(false)
  })
})

describe('hasUpstreamCandidateDivergence', () => {
  it('is true when origin and upstream candidates differ', () => {
    expect(
      hasUpstreamCandidateDivergence(
        state({
          originCandidate: { owner: 'me', repo: 'fork', host: 'github.com' },
          upstreamCandidate: { owner: 'acme', repo: 'orca', host: 'github.com' }
        })
      )
    ).toBe(true)
  })

  it('is false when the upstream candidate is missing', () => {
    expect(
      hasUpstreamCandidateDivergence(
        state({
          originCandidate: { owner: 'me', repo: 'fork', host: 'github.com' },
          upstreamCandidate: null
        })
      )
    ).toBe(false)
  })

  it('is false when origin and upstream candidates match', () => {
    expect(
      hasUpstreamCandidateDivergence(
        state({
          originCandidate: { owner: 'acme', repo: 'orca', host: 'github.com' },
          upstreamCandidate: { owner: 'acme', repo: 'orca', host: 'github.com' }
        })
      )
    ).toBe(false)
  })
})
