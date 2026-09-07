import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { focusRuntimeTerminalSurface } from '@/runtime/sync-runtime-graph'
import type { RuntimeTerminalPresentation } from '../../../../shared/runtime-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../../shared/terminal-tab-types'
import type { AppState } from '../../store/types'

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

export function activateTerminalInitiatedWorktree(store: AppState, worktreeId: string): void {
  store.setActiveView('terminal')
  store.setActiveWorktree(worktreeId)
  store.markWorktreeVisited(worktreeId)
  if (!store.isNavigatingHistory) {
    store.recordWorktreeVisit(worktreeId)
  }
}

type TerminalSplitDirection = 'horizontal' | 'vertical'

function insertLeafAfterSource(
  node: TerminalPaneLayoutNode,
  sourceLeafId: string,
  newLeafId: string,
  direction: TerminalSplitDirection
): { node: TerminalPaneLayoutNode; inserted: boolean } {
  if (node.type === 'leaf') {
    if (node.leafId !== sourceLeafId) {
      return { node, inserted: false }
    }
    return {
      node: {
        type: 'split',
        direction,
        first: node,
        second: { type: 'leaf', leafId: newLeafId },
        ratio: 0.5
      },
      inserted: true
    }
  }
  const first = insertLeafAfterSource(node.first, sourceLeafId, newLeafId, direction)
  if (first.inserted) {
    return { node: { ...node, first: first.node }, inserted: true }
  }
  const second = insertLeafAfterSource(node.second, sourceLeafId, newLeafId, direction)
  return second.inserted
    ? { node: { ...node, second: second.node }, inserted: true }
    : { node, inserted: false }
}

export function addSplitLeafToLayout(
  layout: TerminalLayoutSnapshot | null | undefined,
  sourceLeafId: string,
  newLeafId: string,
  ptyId: string,
  direction: TerminalSplitDirection,
  title?: string | null,
  activateNewLeaf = true
): TerminalLayoutSnapshot {
  const root = layout?.root ?? { type: 'leaf', leafId: sourceLeafId }
  const existingLeafIds = collectLeafIdsInOrder(root)
  const nextActiveLeafId =
    activateNewLeaf || !layout?.activeLeafId || !existingLeafIds.includes(layout.activeLeafId)
      ? newLeafId
      : layout.activeLeafId
  const nextRoot = existingLeafIds.includes(newLeafId)
    ? root
    : (() => {
        const inserted = insertLeafAfterSource(root, sourceLeafId, newLeafId, direction)
        if (inserted.inserted) {
          return inserted.node
        }
        return {
          type: 'split' as const,
          direction,
          first: root,
          second: { type: 'leaf' as const, leafId: newLeafId },
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
  if (!layout?.root || !collectLeafIdsInOrder(layout.root).includes(leafId)) {
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
