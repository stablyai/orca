import type { TabGroupLayoutNode } from '../../../../../shared/tab-types'
import type { TabsSlice, TabsSliceSet } from './tabs-slice-contract'
import { updateSplitRatio } from '../../../../../shared/workspace-layout/tab-group-layout-tree'

export function createTabsSplitRatioActions(
  set: TabsSliceSet
): Pick<TabsSlice, 'setTabGroupSplitRatio'> {
  return {
    setTabGroupSplitRatio: (worktreeId, nodePath, ratio) => {
      set((state) => {
        const currentLayout = state.layoutByWorktree[worktreeId]
        if (!currentLayout) {
          return state
        }
        // No-op ratios must preserve root identity to avoid waking every subscriber (STA-3328).
        let targetNode: TabGroupLayoutNode | undefined = currentLayout
        for (const segment of nodePath.length > 0 ? nodePath.split('.') : []) {
          targetNode =
            targetNode &&
            targetNode.type === 'split' &&
            (segment === 'first' || segment === 'second')
              ? targetNode[segment]
              : undefined
        }
        if (!targetNode || targetNode.type !== 'split' || (targetNode.ratio ?? 0.5) === ratio) {
          return state
        }
        return {
          layoutByWorktree: {
            ...state.layoutByWorktree,
            // Why: split ratios belong to the tab-group model (not transient UI), so persist them for restores and multi-step group ops.
            [worktreeId]: updateSplitRatio(
              currentLayout,
              nodePath.length > 0 ? nodePath.split('.') : [],
              ratio
            )
          }
        }
      })
    }
  }
}
