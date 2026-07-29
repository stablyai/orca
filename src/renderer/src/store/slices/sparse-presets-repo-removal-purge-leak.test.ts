/**
 * Memory-leak regression: removing a repo must purge its sparse-preset maps.
 *
 * The four per-repo maps (`sparsePresetsByRepo`, `sparsePresetsLoadingByRepo`,
 * `sparsePresetsLoadStatusByRepo`, `sparsePresetsErrorByRepo`) are populated
 * lazily by `fetchSparsePresets` but were never pruned when a repo was removed,
 * so orphaned entries accumulated for the renderer's whole session. repoIds are
 * random UUIDs (never reused), so re-adding a repo cannot reclaim the old keys.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTestStore, makeWorktree } from './store-test-helpers'
import type { Repo, SparsePreset } from '../../../../shared/types'

const repo1: Repo = { id: 'repo-1', path: '/r1', displayName: 'R1', badgeColor: '#000', addedAt: 1 }
const repo2: Repo = { id: 'repo-2', path: '/r2', displayName: 'R2', badgeColor: '#111', addedAt: 2 }

const reposRemove = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  reposRemove.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('window', {
    api: {
      repos: { remove: reposRemove },
      pty: { kill: vi.fn() },
      runtimeEnvironments: { call: vi.fn() }
    }
  })
})

function preset(id: string, repoId: string): SparsePreset {
  return { id, repoId, name: id, directories: ['src'], createdAt: 1, updatedAt: 1 }
}

function seed(store: ReturnType<typeof createTestStore>): void {
  store.setState({
    repos: [repo1, repo2],
    worktreesByRepo: {
      [repo1.id]: [makeWorktree({ id: 'repo-1::/r1/wt1', repoId: repo1.id, path: '/r1/wt1' })],
      [repo2.id]: [makeWorktree({ id: 'repo-2::/r2/wt1', repoId: repo2.id, path: '/r2/wt1' })]
    },
    sparsePresetsByRepo: {
      [repo1.id]: [preset('p1', repo1.id)],
      [repo2.id]: [preset('p2', repo2.id)]
    },
    sparsePresetsLoadingByRepo: { [repo1.id]: false, [repo2.id]: false },
    sparsePresetsLoadStatusByRepo: { [repo1.id]: 'loaded', [repo2.id]: 'loaded' },
    sparsePresetsErrorByRepo: { [repo1.id]: 'stale', [repo2.id]: 'boom' }
  })
}

describe('removeProject purges the removed repo sparse-preset maps (leak regression)', () => {
  it('drops all four sparse-preset maps for the removed repo, keeps the surviving repo', async () => {
    const store = createTestStore()
    seed(store)

    await store.getState().removeProject(repo1.id)

    const s = store.getState()
    // Removed repo: every sparse-preset map key is gone.
    expect(repo1.id in s.sparsePresetsByRepo).toBe(false)
    expect(repo1.id in s.sparsePresetsLoadingByRepo).toBe(false)
    expect(repo1.id in s.sparsePresetsLoadStatusByRepo).toBe(false)
    expect(repo1.id in s.sparsePresetsErrorByRepo).toBe(false)
    // Surviving repo: retained (guard over-eviction).
    expect(s.sparsePresetsByRepo[repo2.id]).toEqual([preset('p2', repo2.id)])
    expect(s.sparsePresetsLoadingByRepo[repo2.id]).toBe(false)
    expect(s.sparsePresetsLoadStatusByRepo[repo2.id]).toBe('loaded')
    expect(s.sparsePresetsErrorByRepo[repo2.id]).toBe('boom')
  })
})
