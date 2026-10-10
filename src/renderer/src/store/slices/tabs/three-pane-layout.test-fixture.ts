import type { AppState } from '../../types'
import { makeTabGroup } from './tab-group.test-fixture'

/** Seeds three panes so a test about in-group tab semantics is subject to neither automatic
 *  placement rule (tabs/lone-pane-split-source.ts): beside one pane, opposite one of two.
 *  New tabs land in the left group, which is index 0 of groupsByWorktree. */
export function seedThreePaneLayout(
  store: { setState: (updater: (state: AppState) => Partial<AppState>) => void },
  worktreeId: string
): { leftGroupId: string; rightGroupId: string; thirdGroupId: string } {
  const leftGroupId = `${worktreeId}::left-pane`
  const rightGroupId = `${worktreeId}::right-pane`
  const thirdGroupId = `${worktreeId}::third-pane`
  store.setState((state) => ({
    groupsByWorktree: {
      ...state.groupsByWorktree,
      [worktreeId]: [
        makeTabGroup({ id: leftGroupId, worktreeId }),
        makeTabGroup({ id: rightGroupId, worktreeId }),
        makeTabGroup({ id: thirdGroupId, worktreeId })
      ]
    },
    activeGroupIdByWorktree: { ...state.activeGroupIdByWorktree, [worktreeId]: leftGroupId },
    layoutByWorktree: {
      ...state.layoutByWorktree,
      [worktreeId]: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', groupId: leftGroupId },
        second: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: rightGroupId },
          second: { type: 'leaf', groupId: thirdGroupId }
        }
      }
    }
  }))
  return { leftGroupId, rightGroupId, thirdGroupId }
}
