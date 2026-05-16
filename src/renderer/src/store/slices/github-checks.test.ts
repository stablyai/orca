import { describe, expect, it } from 'vitest'
import { syncPRChecksStatus, normalizeBranchName } from './github-checks'
import type { AppState } from '../types'

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
})
