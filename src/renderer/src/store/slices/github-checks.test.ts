import { describe, expect, it } from 'vitest'
import {
  deriveCheckStatusFromChecks,
  syncPRChecksStatus,
  normalizeBranchName
} from './github-checks'
import type { AppState } from '../types'
import type { PRCheckDetail } from '../../../../shared/github/check-types'

describe('deriveCheckStatusFromChecks', () => {
  it('retains action_required as a coarse merge-blocking failure status', () => {
    const checks: PRCheckDetail[] = [
      { name: 'build', status: 'completed', conclusion: 'success', url: null },
      { name: 'approval', status: 'completed', conclusion: 'action_required', url: null }
    ]
    expect(deriveCheckStatusFromChecks(checks)).toBe('failure')
  })

  it('keeps an unknown terminal conclusion neutral rather than pending', () => {
    const checks = [
      { name: 'future-check', status: 'completed', conclusion: 'future_state', url: null }
    ] as unknown as PRCheckDetail[]
    expect(deriveCheckStatusFromChecks(checks)).toBe('neutral')
  })
})

describe('normalizeBranchName', () => {
  it('strips refs/heads/ prefix', () => {
    expect(normalizeBranchName('refs/heads/main')).toBe('main')
  })

  it('returns branch as-is when no prefix', () => {
    expect(normalizeBranchName('feature/foo')).toBe('feature/foo')
  })

  it('returns empty string for refs/heads/ only', () => {
    expect(normalizeBranchName('refs/heads/')).toBe('')
  })
})

describe('syncPRChecksStatus', () => {
  const baseState = {
    prCache: {
      'repo-id::main': {
        fetchedAt: 0,
        data: { checksStatus: 'neutral' as const }
      }
    }
  } as unknown as AppState

  it('returns null for undefined branch', () => {
    expect(syncPRChecksStatus(baseState, '/repo', 'repo-id', undefined, [])).toBeNull()
  })

  it('returns null for empty string branch', () => {
    expect(syncPRChecksStatus(baseState, '/repo', 'repo-id', '', [])).toBeNull()
  })

  it('returns null for refs/heads/ only (normalizes to empty)', () => {
    expect(syncPRChecksStatus(baseState, '/repo', 'repo-id', 'refs/heads/', [])).toBeNull()
  })

  it('uses repoId-scoped key when syncing status', () => {
    const result = syncPRChecksStatus(baseState, '/repo', 'repo-id', 'main', [
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ])
    expect(result?.prCache?.['repo-id::main']?.data?.checksStatus).toBe('success')
  })

  it('keeps the matching hosted review cache in sync with detailed checks', () => {
    const state = {
      prCache: {
        'repo-id::main': {
          fetchedAt: 0,
          data: { number: 12, checksStatus: 'neutral' as const }
        }
      },
      hostedReviewCache: {
        'local::repo-id::main': {
          fetchedAt: 0,
          data: { provider: 'github', number: 12, status: 'neutral' as const }
        }
      }
    } as unknown as AppState

    const result = syncPRChecksStatus(
      state,
      '/repo',
      'repo-id',
      'main',
      [{ name: 'approval', status: 'completed', conclusion: 'action_required', url: null }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    )

    expect(result?.hostedReviewCache?.['local::repo-id::main']?.data).toMatchObject({
      status: 'failure',
      checksPresentationStatus: 'action_required'
    })
  })

  it('updates a matching hosted review after the PR cache entry was evicted', () => {
    const state = {
      prCache: {},
      hostedReviewCache: {
        'local::repo-id::main': {
          fetchedAt: 0,
          data: { provider: 'github', number: 12, status: 'neutral' as const }
        }
      }
    } as unknown as AppState

    const result = syncPRChecksStatus(
      state,
      '/repo',
      'repo-id',
      'main',
      [{ name: 'approval', status: 'completed', conclusion: 'action_required', url: null }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      12
    )

    expect(result?.prCache).toBeUndefined()
    expect(result?.hostedReviewCache?.['local::repo-id::main']?.data).toMatchObject({
      status: 'failure',
      checksPresentationStatus: 'action_required'
    })
  })

  it('does not overwrite a hosted review that has advanced to a different head', () => {
    const state = {
      prCache: {
        'repo-id::main': {
          fetchedAt: 0,
          data: { number: 12, headSha: 'old-head', checksStatus: 'neutral' as const }
        }
      },
      hostedReviewCache: {
        'local::repo-id::main': {
          fetchedAt: 1,
          data: {
            provider: 'github',
            number: 12,
            headSha: 'new-head',
            status: 'success' as const
          }
        }
      }
    } as unknown as AppState

    const result = syncPRChecksStatus(
      state,
      '/repo',
      'repo-id',
      'main',
      [{ name: 'approval', status: 'completed', conclusion: 'action_required', url: null }],
      'old-head',
      undefined,
      undefined,
      undefined,
      undefined,
      true
    )

    expect(result?.prCache?.['repo-id::main']?.data?.checksPresentationStatus).toBe(
      'action_required'
    )
    expect(result?.hostedReviewCache).toBeUndefined()
  })

  it('updates the local repo key while a runtime is focused when repo owner is known', () => {
    const state = {
      prCache: {
        'repo-id::main': {
          fetchedAt: 0,
          data: { number: 12, checksStatus: 'neutral' as const }
        },
        'runtime:env-win::repo-id::main': {
          fetchedAt: 0,
          data: { number: 12, checksStatus: 'neutral' as const }
        }
      },
      hostedReviewCache: {
        'local::repo-id::main': {
          fetchedAt: 0,
          data: { provider: 'github', number: 12, status: 'neutral' as const }
        },
        'runtime:env-win::repo-id::main': {
          fetchedAt: 0,
          data: { provider: 'github', number: 12, status: 'neutral' as const }
        }
      }
    } as unknown as AppState

    const result = syncPRChecksStatus(
      state,
      '/repo',
      'repo-id',
      'main',
      [{ name: 'build', status: 'completed', conclusion: 'success', url: null }],
      undefined,
      undefined,
      { activeRuntimeEnvironmentId: 'env-win' } as AppState['settings'],
      null,
      null,
      true
    )

    expect(result?.prCache?.['repo-id::main']?.data?.checksStatus).toBe('success')
    expect(result?.prCache?.['runtime:env-win::repo-id::main']?.data?.checksStatus).toBe('neutral')
    expect(result?.hostedReviewCache?.['local::repo-id::main']?.data?.status).toBe('success')
    expect(result?.hostedReviewCache?.['runtime:env-win::repo-id::main']?.data?.status).toBe(
      'neutral'
    )
  })

  it('rejects a checks result from the same slug on a different GitHub host', () => {
    const state = {
      prCache: {
        'repo-id::main': {
          fetchedAt: 0,
          data: {
            checksStatus: 'neutral' as const,
            prRepo: {
              owner: 'acme',
              repo: 'widgets',
              host: 'github.acme-corp.com'
            }
          }
        }
      }
    } as unknown as AppState

    const result = syncPRChecksStatus(
      state,
      '/repo',
      'repo-id',
      'main',
      [{ name: 'build', status: 'completed', conclusion: 'success', url: null }],
      undefined,
      { owner: 'acme', repo: 'widgets', host: 'github.com' }
    )

    expect(result).toBeNull()
  })

  it('does not update a hosted review owned by a different GitHub host', () => {
    const state = {
      prCache: {},
      hostedReviewCache: {
        'local::repo-id::main': {
          fetchedAt: 0,
          data: {
            provider: 'github',
            number: 12,
            status: 'neutral' as const,
            githubRepository: {
              owner: 'acme',
              repo: 'widgets',
              host: 'github.acme-corp.com'
            }
          }
        }
      }
    } as unknown as AppState

    const result = syncPRChecksStatus(
      state,
      '/repo',
      'repo-id',
      'main',
      [{ name: 'build', status: 'completed', conclusion: 'success', url: null }],
      undefined,
      { owner: 'acme', repo: 'widgets', host: 'github.com' },
      undefined,
      undefined,
      undefined,
      true,
      12
    )

    expect(result).toBeNull()
  })

  it('does not update a known hosted-review repository from an unscoped checks result', () => {
    const state = {
      prCache: {},
      hostedReviewCache: {
        'local::repo-id::main': {
          fetchedAt: 0,
          data: {
            provider: 'github',
            number: 12,
            status: 'neutral' as const,
            githubRepository: { owner: 'acme', repo: 'widgets', host: 'github.com' }
          }
        }
      }
    } as unknown as AppState

    const result = syncPRChecksStatus(
      state,
      '/repo',
      'repo-id',
      'main',
      [{ name: 'build', status: 'completed', conclusion: 'success', url: null }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      12
    )

    expect(result).toBeNull()
  })
})
