/**
 * Ghost "Unknown" sidebar row regression: removing a project must drop its whole
 * worktree bucket when the repo id no longer survives on any host.
 *
 * `removeProject` filtered `worktreesByRepo[projectId]` host-scoped only and kept
 * the bucket whenever any host-mismatched worktree remained — even after the repo
 * id was fully removed from `repos`. A worktree left stamped with an abandoned
 * host (e.g. a removed SSH connection the user reached as "M424") then survived in
 * the bucket with no repo to render under, so the sidebar labeled it "Unknown"
 * (worktree-list-groups.ts `repo?.displayName ?? 'Unknown'`). The persisted
 * lastVisited timestamps already cascaded on `repoIdFullyRemoved`; the worktree
 * bucket did not. This mirrors the reported flow: an M424-connection worktree was
 * left behind after the repo was re-homed/removed, surfacing as a ghost row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTestStore, makeWorktree } from './store-test-helpers'
import type { Repo } from '../../../../shared/types'

// Single repo entry, homed on the local host (its M424 connection is long gone).
const repo: Repo = {
  id: 'repo-1',
  path: '/r1',
  displayName: 'R1',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'local'
}

const reposRemove = vi.fn().mockResolvedValue(undefined)
const ptyKill = vi.fn()

beforeEach(() => {
  reposRemove.mockReset().mockResolvedValue(undefined)
  ptyKill.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: { remove: reposRemove },
      pty: { kill: ptyKill },
      runtimeEnvironments: { call: vi.fn() }
    }
  })
})

// Owner-host worktree (local) plus a leftover stamped with the abandoned
// "M424" SSH connection host that no longer exists.
const WLOCAL = 'repo-1::/r1/wt-local'
const WGHOST = 'repo-1::/r1/wt-m424'

describe('removeProject drops orphaned worktree buckets (Unknown ghost regression)', () => {
  it('deletes the whole bucket when the repo id is fully removed', async () => {
    const store = createTestStore()
    store.setState({
      repos: [repo],
      worktreesByRepo: {
        [repo.id]: [
          makeWorktree({ id: WLOCAL, repoId: repo.id, path: '/r1/wt-local' }),
          makeWorktree({
            id: WGHOST,
            repoId: repo.id,
            path: '/r1/wt-m424',
            hostId: 'ssh:m424'
          })
        ]
      },
      detectedWorktreesByRepo: {
        [repo.id]: {
          worktrees: [
            makeWorktree({
              id: WGHOST,
              repoId: repo.id,
              path: '/r1/wt-m424',
              hostId: 'ssh:m424'
            })
          ]
        } as never
      }
    })

    await store.getState().removeProject(repo.id)

    const s = store.getState()
    // No repo owns 'repo-1' anymore, so no host-mismatched leftover may remain.
    expect(s.repos.some((r) => r.id === repo.id)).toBe(false)
    expect(s.worktreesByRepo[repo.id]).toBeUndefined()
    expect(s.detectedWorktreesByRepo[repo.id]).toBeUndefined()
  })
})
