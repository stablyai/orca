import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph/mobile-session-snapshots'
import { makeState } from './sync-runtime-graph-test-harness'
import type { AppState } from '../store/types'

describe('buildMobileSessionTabSnapshots', () => {
  it('evicts a removed folder workspace from the snapshot cache', () => {
    const folderWorkspaceId = 'cache-eviction-folder'
    const folderKey = `folder:${folderWorkspaceId}`
    const liveState = makeState({
      folderWorkspaces: [{ id: folderWorkspaceId } as AppState['folderWorkspaces'][number]],
      tabsByWorktree: {
        [folderKey]: [{ id: 'term-1', title: 'Terminal 1' }]
      } as unknown as AppState['tabsByWorktree']
    })
    const removedState = makeState({
      folderWorkspaces: [],
      tabsByWorktree: liveState.tabsByWorktree
    })

    const initial = buildMobileSessionTabSnapshots(liveState)[0]!
    expect(buildMobileSessionTabSnapshots(removedState)).toEqual([])
    const restored = buildMobileSessionTabSnapshots(liveState)[0]!

    expect(restored.snapshotVersion).toBeGreaterThan(initial.snapshotVersion)
  })

  it('publishes a new instance identity when unchanged content is recreated', () => {
    const worktree = {
      id: 'wt-1',
      instanceId: 'old-instance',
      repoId: 'repo-1'
    }
    const base = makeState({
      worktreesByRepo: { 'repo-1': [worktree] } as unknown as AppState['worktreesByRepo'],
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'Terminal 1' }]
      } as unknown as AppState['tabsByWorktree']
    })
    const initial = buildMobileSessionTabSnapshots(base)[0]!
    const recreated = {
      ...base,
      worktreesByRepo: {
        'repo-1': [{ ...worktree, instanceId: 'new-instance' }]
      } as unknown as AppState['worktreesByRepo']
    }

    const next = buildMobileSessionTabSnapshots(recreated)[0]!

    expect(initial.worktreeInstanceId).toBe('old-instance')
    expect(next.worktreeInstanceId).toBe('new-instance')
    expect(next.snapshotVersion).toBeGreaterThan(initial.snapshotVersion)
  })
})
