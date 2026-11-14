import { terminalSplitSide } from '../../../../shared/workspace-layout/terminal-topology/terminal-split-side'
import '../../components/terminal-pane/layout/terminal-layout-leaf-traversal'
import {
  collectLayoutLeafIdsInOrder,
  insertLeafBeside,
  layoutContainsLeafId
} from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import { focusTerminalTabSurface } from '@/components/terminal-pane/input/focus/focus-terminal-tab-surface'
import { focusRuntimeTerminalSurface } from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import type { RuntimeTerminalPresentation } from '../../../../shared/runtime-terminal-contracts'
import type { TerminalLayoutSnapshot } from '../../../../shared/workspace-layout/terminal-tab-types'

export function resolveTerminalPresentation(data: {
  presentation?: RuntimeTerminalPresentation
  activate?: boolean
  focus?: boolean
}): RuntimeTerminalPresentation | undefined {
  if (data.presentation) {
    return data.presentation
  }
  if (data.focus !== undefined) {
    return data.focus ? 'focused' : 'background'
  }
  if (data.activate === true) {
    return 'focused'
  }
  return undefined
}

export function focusTerminalInitiatedTab(
  tabId: string,
  leafId?: string | null,
  worktreeId?: string
): void {
  if (!focusRuntimeTerminalSurface(tabId, leafId, worktreeId)) {
    focusTerminalTabSurface(tabId, leafId)
  }
}

type TerminalSplitDirection = 'horizontal' | 'vertical'

export function addSplitLeafToLayout(
  layout: TerminalLayoutSnapshot | null | undefined,
  sourceLeafId: string,
  newLeafId: string,
  ptyId: string,
  direction: TerminalSplitDirection,
  title?: string | null,
  activateNewLeaf = true,
  insertBefore = false
): TerminalLayoutSnapshot {
  const root = layout?.root ?? { type: 'leaf', leafId: sourceLeafId }
  const existingLeafIds = collectLayoutLeafIdsInOrder(root)
  const nextActiveLeafId =
    activateNewLeaf || !layout?.activeLeafId || !existingLeafIds.includes(layout.activeLeafId)
      ? newLeafId
      : layout.activeLeafId
  const nextRoot = existingLeafIds.includes(newLeafId)
    ? root
    : (() => {
        if (layoutContainsLeafId(root, sourceLeafId)) {
          return insertLeafBeside(
            root,
            sourceLeafId,
            newLeafId,
            terminalSplitSide(direction, insertBefore)
          )
        }
        return {
          type: 'split' as const,
          direction,
          first: insertBefore ? { type: 'leaf' as const, leafId: newLeafId } : root,
          second: insertBefore ? root : { type: 'leaf' as const, leafId: newLeafId },
          ratio: 0.5
        }
      })()
  return {
    ...(layout ?? { root: null, activeLeafId: null, expandedLeafId: null }),
    root: nextRoot,
    activeLeafId: nextActiveLeafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { ...layout?.ptyIdsByLeafId, [newLeafId]: ptyId },
    ...(title ? { titlesByLeafId: { ...layout?.titlesByLeafId, [newLeafId]: title } } : {})
  }
}

export function activateExistingLeafInLayout(
  layout: TerminalLayoutSnapshot | null | undefined,
  leafId: string,
  ptyId: string,
  title?: string | null
): TerminalLayoutSnapshot | null {
  if (!layout?.root || !collectLayoutLeafIdsInOrder(layout.root).includes(leafId)) {
    return null
  }
  return {
    ...layout,
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [leafId]: ptyId },
    ...(title ? { titlesByLeafId: { ...layout.titlesByLeafId, [leafId]: title } } : {})
  }
}
