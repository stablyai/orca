import { editSessionSource } from '@/store/session-source-edits'
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
          return undefined
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
          return undefined
        }
        return editSessionSource(state)
          .set(
            'layoutByWorktree',
            worktreeId,
            updateSplitRatio(currentLayout, nodePath.length > 0 ? nodePath.split('.') : [], ratio)
          )
          .finish({})
      })
    }
  }
}
