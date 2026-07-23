import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { MAX_WORKSPACE_CLEANUP_VIEWED_CANDIDATES } from './workspace-cleanup'
import { createCleanupTestStore, makeCandidate } from './workspace-cleanup-slice-test-harness'

describe('workspace cleanup viewed-candidate retention', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prunes expired records before recording a new view', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10 * 60 * 60 * 1000)
    const store = createCleanupTestStore(vi.fn())
    store.setState({
      workspaceCleanupViewedCandidates: Object.fromEntries(
        Array.from({ length: 1_000 }, (_, index) => [
          `expired-${index}`,
          { viewedAt: 0, fingerprint: `old-${index}`, wasSuggested: true }
        ])
      )
    } as Partial<AppState>)

    store.getState().markWorkspaceCleanupCandidateViewed(makeCandidate())

    expect(Object.keys(store.getState().workspaceCleanupViewedCandidates)).toEqual([
      makeCandidate().worktreeId
    ])
  })

  it('keeps only the newest bounded set of recent records', () => {
    const now = 10 * 60 * 60 * 1000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const store = createCleanupTestStore(vi.fn())
    store.setState({
      workspaceCleanupViewedCandidates: Object.fromEntries(
        Array.from({ length: MAX_WORKSPACE_CLEANUP_VIEWED_CANDIDATES }, (_, index) => [
          `recent-${index}`,
          { viewedAt: now - index - 1, fingerprint: `recent-${index}`, wasSuggested: true }
        ])
      )
    } as Partial<AppState>)

    store.getState().markWorkspaceCleanupCandidateViewed(makeCandidate())

    const retained = store.getState().workspaceCleanupViewedCandidates
    expect(Object.keys(retained)).toHaveLength(MAX_WORKSPACE_CLEANUP_VIEWED_CANDIDATES)
    expect(retained['recent-0']).toBeDefined()
    expect(retained[`recent-${MAX_WORKSPACE_CLEANUP_VIEWED_CANDIDATES - 1}`]).toBeUndefined()
  })
})
