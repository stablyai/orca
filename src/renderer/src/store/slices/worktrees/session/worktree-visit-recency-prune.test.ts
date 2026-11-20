import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '../worktree.test-fixture'

const LIVE = 'repo-1::/workspaces/live'
const CREATED = 'repo-1::/workspaces/created'
const GONE = 'repo-1::/workspaces/gone'
const UNLOADED = 'repo-2::/workspaces/unloaded'

describe('pruneLastVisitedTimestamps', () => {
  // QA on #42580: the window kept a deleted workspace's flag and saved it back after main removed it.
  it('drops default-tab flags only of worktrees no list still shows', () => {
    const live = makeWorktree({ id: LIVE, repoId: 'repo-1' })
    useAppStore.setState({
      // A worktree created after the scan is listed before the scan sees it.
      worktreesByRepo: { 'repo-1': [live, makeWorktree({ id: CREATED, repoId: 'repo-1' })] },
      detectedWorktreesByRepo: {
        'repo-1': {
          repoId: 'repo-1',
          authoritative: true,
          source: 'git',
          worktrees: [
            { ...live, ownership: 'orca-managed', selectedCheckout: false, visible: true }
          ]
        }
      },
      defaultTerminalTabsAppliedByWorktreeId: {
        [LIVE]: true,
        [CREATED]: true,
        [GONE]: true,
        [UNLOADED]: true,
        'folder:workspace-1': true
      }
    })

    useAppStore.getState().pruneLastVisitedTimestamps()

    expect(useAppStore.getState().defaultTerminalTabsAppliedByWorktreeId).toEqual({
      [LIVE]: true,
      [CREATED]: true,
      [UNLOADED]: true,
      'folder:workspace-1': true
    })
  })
})
