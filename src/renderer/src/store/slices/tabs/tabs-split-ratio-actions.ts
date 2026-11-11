import type { TabGroupLayoutNode } from '../../../../../shared/tab-types'
import type { TabsSlice, TabsSliceSet } from './tabs-slice-contract'
import {
  equalizeSplitRunRatios,
  updateSplitRatio
} from '../../../../../shared/workspace-layout/tab-group-layout-tree'
import { replaceRecordEntries } from '../../keyed-record-transitions'

export function createTabsSplitRatioActions(
  set: TabsSliceSet
): Pick<TabsSlice, 'setTabGroupSplitRatio' | 'equalizeTabGroupSplitRun'> {
  const writeLayout = (
    worktreeId: string,
    edit: (layout: TabGroupLayoutNode) => TabGroupLayoutNode
  ): void => {
    set((state) => {
      const currentLayout = state.layoutByWorktree[worktreeId]
      if (!currentLayout) {
        return state
      }
      const nextLayout = edit(currentLayout)
      // No-op ratios must preserve root identity to avoid waking every subscriber (STA-3328).
      if (nextLayout === currentLayout) {
        return state
      }
      return {
        // Why: split ratios belong to the tab-group model (not transient UI), so persist them for restores and multi-step group ops.
        layoutByWorktree: replaceRecordEntries(state.layoutByWorktree, [[worktreeId, nextLayout]])
      }
    })
  }

  return {
    setTabGroupSplitRatio: (worktreeId, nodePath, ratio) => {
      const path = nodePath.length > 0 ? nodePath.split('.') : []
      writeLayout(worktreeId, (layout) => {
        let targetNode: TabGroupLayoutNode | undefined = layout
        for (const segment of path) {
          targetNode =
            targetNode &&
            targetNode.type === 'split' &&
            (segment === 'first' || segment === 'second')
              ? targetNode[segment]
              : undefined
        }
        if (!targetNode || targetNode.type !== 'split' || (targetNode.ratio ?? 0.5) === ratio) {
          return layout
        }
        return updateSplitRatio(layout, path, ratio)
      })
    },
    equalizeTabGroupSplitRun: (worktreeId, nodePath) => {
      writeLayout(worktreeId, (layout) =>
        equalizeSplitRunRatios(layout, nodePath.length > 0 ? nodePath.split('.') : [])
      )
    }
  }
}
