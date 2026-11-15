import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '../worktree.test-fixture'

const LIVE = 'repo-1::/workspaces/live'
const GONE = 'repo-1::/workspaces/gone'
const UNLOADED = 'repo-2::/workspaces/unloaded'

describe('pruneLastVisitedTimestamps', () => {
  // QA on #42580: the window kept a deleted workspace's flag and saved it back after main removed it.
  it('drops default-tab flags of worktrees a loaded repo no longer lists', () => {
    useAppStore.setState({
      worktreesByRepo: { 'repo-1': [makeWorktree({ id: LIVE, repoId: 'repo-1' })] },
      detectedWorktreesByRepo: {},
      defaultTerminalTabsAppliedByWorktreeId: {
        [LIVE]: true,
        [GONE]: true,
        [UNLOADED]: true,
        'folder:workspace-1': true
      }
    })

    useAppStore.getState().pruneLastVisitedTimestamps()

    expect(useAppStore.getState().defaultTerminalTabsAppliedByWorktreeId).toEqual({
      [LIVE]: true,
      [UNLOADED]: true,
      'folder:workspace-1': true
    })
  })
})
