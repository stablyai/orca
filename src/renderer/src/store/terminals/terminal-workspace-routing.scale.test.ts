import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import {
  getRemoteConnectionIdForWorktree,
  worktreeUsesRemoteConnection,
  worktreeUsesWslPath
} from './terminal-workspace-routing'
import { rightSidebarShowsPullRequestData } from '@/lib/right-sidebar-visibility'

const REPO_COUNT = 10
const WORKTREE_COUNT = 400

/** Counts every `id` read so a rescan shows up as a multiple of the row count. */
function buildCountingState(): {
  state: AppState
  reads: () => number
  worktreeId: string
} {
  let idReads = 0
  const repos = Array.from({ length: REPO_COUNT }, (_, index) => ({
    id: `repo-${index}`,
    name: `repo-${index}`,
    path: `/repos/repo-${index}`,
    connectionId: null
  }))
  const worktreesByRepo: Record<string, unknown[]> = {}
  const perRepo = WORKTREE_COUNT / REPO_COUNT
  for (let repoIndex = 0; repoIndex < REPO_COUNT; repoIndex++) {
    worktreesByRepo[`repo-${repoIndex}`] = Array.from({ length: perRepo }, (_, index) => {
      const id = `repo-${repoIndex}::/repos/repo-${repoIndex}/wt-${index}`
      return {
        get id() {
          idReads++
          return id
        },
        repoId: `repo-${repoIndex}`,
        path: `/repos/repo-${repoIndex}/wt-${index}`,
        branch: `branch-${index}`,
        hostId: 'local'
      }
    })
  }
  return {
    state: {
      repos,
      worktreesByRepo,
      folderWorkspaces: [],
      projectGroups: [],
      activeView: 'worktrees',
      activeWorktreeId: 'repo-9::/repos/repo-9/wt-39',
      rightSidebarOpen: true,
      rightSidebarTab: 'checks'
    } as unknown as AppState,
    reads: () => idReads,
    worktreeId: 'repo-9::/repos/repo-9/wt-39'
  }
}

describe('terminal workspace routing scales with tab count, not workspace count', () => {
  it('answers repeated owner lookups without rescanning every worktree', () => {
    const { state, reads, worktreeId } = buildCountingState()
    const CALLS = 200

    for (let call = 0; call < CALLS; call++) {
      worktreeUsesRemoteConnection(state, worktreeId)
      getRemoteConnectionIdForWorktree(state, worktreeId)
      worktreeUsesWslPath(state, worktreeId)
      rightSidebarShowsPullRequestData(state)
    }

    // One index build over every row, then O(1) map hits. A per-call scan would
    // read at least CALLS x WORKTREE_COUNT ids.
    expect(reads()).toBeLessThanOrEqual(WORKTREE_COUNT * 2)
    expect(reads()).toBeLessThan(CALLS * WORKTREE_COUNT)
  })

  it('still resolves the owning repo and its connection', () => {
    const { state, worktreeId } = buildCountingState()
    const remoteState = {
      ...state,
      repos: state.repos.map((repo) =>
        repo.id === 'repo-9' ? { ...repo, connectionId: 'ssh-host-1' } : repo
      )
    } as AppState

    expect(worktreeUsesRemoteConnection(remoteState, worktreeId)).toBe(true)
    expect(getRemoteConnectionIdForWorktree(remoteState, worktreeId)).toBe('ssh-host-1')
    expect(worktreeUsesRemoteConnection(state, worktreeId)).toBe(false)
    expect(getRemoteConnectionIdForWorktree(state, worktreeId)).toBeNull()
    expect(worktreeUsesWslPath(state, worktreeId)).toBe(false)
  })

  it('returns null for a worktree id that no repo owns', () => {
    const { state } = buildCountingState()
    expect(getRemoteConnectionIdForWorktree(state, 'ghost::/nowhere')).toBeNull()
    expect(worktreeUsesRemoteConnection(state, 'ghost::/nowhere')).toBe(false)
  })
})
