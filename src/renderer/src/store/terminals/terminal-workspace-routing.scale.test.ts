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

    // One index build plus O(1) hits; rescanning costs CALLS × WORKTREE_COUNT ID reads.
    expect(reads()).toBeLessThanOrEqual(WORKTREE_COUNT * 2)
    expect(reads()).toBeLessThan(CALLS * WORKTREE_COUNT)
  })
})
