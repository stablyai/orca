import { describe, expect, it } from 'vitest'
import { getGitHubPRCacheKey } from './github-cache-key'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'

const focusedRuntime = { activeRuntimeEnvironmentId: 'env-focused' }

describe('repo owner cache identity', () => {
  it('uses local PR and hosted-review keys for known local repos while a runtime is focused', () => {
    expect(
      getGitHubPRCacheKey('/repo', 'repo-1', 'feature/local', focusedRuntime, null, null, true)
    ).toBe('repo-1::feature/local')
    expect(
      getHostedReviewCacheKey('/repo', 'feature/local', focusedRuntime, 'repo-1', null, null, true)
    ).toBe('local::repo-1::feature/local')
  })

  it('preserves focused-runtime fallback when repo owner context is missing', () => {
    expect(getGitHubPRCacheKey('/repo', 'repo-1', 'feature/local', focusedRuntime)).toBe(
      'runtime:env-focused::repo-1::feature/local'
    )
    expect(getHostedReviewCacheKey('/repo', 'feature/local', focusedRuntime, 'repo-1')).toBe(
      'runtime:env-focused::repo-1::feature/local'
    )
  })

  it('keeps explicit runtime and SSH owners scoped to their owner host', () => {
    expect(
      getGitHubPRCacheKey(
        '/repo',
        'repo-1',
        'feature/remote',
        null,
        null,
        'runtime:env-owner',
        true
      )
    ).toBe('runtime:env-owner::repo-1::feature/remote')
    expect(
      getHostedReviewCacheKey('/repo', 'feature/ssh', focusedRuntime, 'repo-1', 'ssh-1', null, true)
    ).toBe('ssh:ssh-1::repo-1::feature/ssh')
  })
})
