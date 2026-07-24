import { describe, expect, it } from 'vitest'
import {
  deriveCheckStatusFromChecks,
  syncPRChecksStatus,
  normalizeBranchName
} from './github-checks'
import type { AppState } from '../types'
import type { PRCheckDetail } from '../../../../shared/types'

describe('deriveCheckStatusFromChecks', () => {
  it('treats an action_required check as failure so it is not a silent pass', () => {
    const checks: PRCheckDetail[] = [
      { name: 'build', status: 'completed', conclusion: 'success', url: null },
      { name: 'approval', status: 'completed', conclusion: 'action_required', url: null }
    ]
    expect(deriveCheckStatusFromChecks(checks)).toBe('failure')
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

  it('updates the local repo key while a runtime is focused when repo owner is known', () => {
    const state = {
      prCache: {
        'repo-id::main': {
          fetchedAt: 0,
          data: { checksStatus: 'neutral' as const }
        },
        'runtime:env-win::repo-id::main': {
          fetchedAt: 0,
          data: { checksStatus: 'neutral' as const }
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
})
