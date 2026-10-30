import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import type { TreeNode } from './file-explorer-types'

export type NavigationKey =
  | 'ArrowDown'
  | 'ArrowUp'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown'

export type ResolvedNavigation =
  | { type: 'move'; targetIndex: number }
  | { type: 'toggle-expand'; currentIndex: number; dirPath: string }
  | { type: 'toggle-collapse'; currentIndex: number; dirPath: string }
  | { type: 'no-op' }
  | { type: 'unhandled' }

export type SelectionMode = 'replace' | 'toggle' | 'range' | 'additive-range'

/** Use visible tree order; Left/Right collapse/expand or navigate parent/child, with Home/End/Page keys for larger jumps. */
export function resolveFileExplorerNavigationTarget(args: {
  key: NavigationKey
  currentIndex: number | null
  rowProjection: FileExplorerRowProjection
  total: number
  isExpanded: (path: string) => boolean
}): ResolvedNavigation {
  const { key, currentIndex, rowProjection, total, isExpanded } = args
  if (total === 0) {
    return { type: 'no-op' }
  }

  if (currentIndex === null) {
    if (key === 'ArrowDown' || key === 'End' || key === 'PageDown') {
      return { type: 'move', targetIndex: 0 }
    }
    if (key === 'ArrowUp' || key === 'Home' || key === 'PageUp') {
      return { type: 'move', targetIndex: total - 1 }
    }
    return { type: 'unhandled' }
  }

  switch (key) {
    case 'ArrowDown':
      return { type: 'move', targetIndex: Math.min(total - 1, currentIndex + 1) }
    case 'ArrowUp':
      return { type: 'move', targetIndex: Math.max(0, currentIndex - 1) }
    case 'Home':
      return { type: 'move', targetIndex: 0 }
    case 'End':
      return { type: 'move', targetIndex: total - 1 }
    case 'PageDown': {
      const pageSize = Math.max(1, Math.floor(total / 10))
      return { type: 'move', targetIndex: Math.min(total - 1, currentIndex + pageSize) }
    }
    case 'PageUp': {
      const pageSize = Math.max(1, Math.floor(total / 10))
      return { type: 'move', targetIndex: Math.max(0, currentIndex - pageSize) }
    }
    case 'ArrowRight': {
      const node = rowProjection.getRowAtIndex(currentIndex)
      if (!node || !node.isDirectory) {
        return { type: 'move', targetIndex: currentIndex }
      }
      if (!isExpanded(node.path)) {
        return { type: 'toggle-expand', currentIndex, dirPath: node.path }
      }
      const firstChild = rowProjection.getFirstChildIndex(currentIndex)
      return { type: 'move', targetIndex: firstChild ?? currentIndex }
    }
    case 'ArrowLeft': {
      const node = rowProjection.getRowAtIndex(currentIndex)
      if (!node) {
        return { type: 'no-op' }
      }
      if (node.isDirectory && isExpanded(node.path)) {
        return { type: 'toggle-collapse', currentIndex, dirPath: node.path }
      }
      const parent = rowProjection.getParentIndex(currentIndex)
      if (parent === null) {
        return { type: 'no-op' }
      }
      return { type: 'move', targetIndex: parent }
    }
  }
}

const NAVIGATION_KEY_SET: Record<NavigationKey, true> = {
  ArrowDown: true,
  ArrowUp: true,
  ArrowLeft: true,
  ArrowRight: true,
  Home: true,
  End: true,
  PageUp: true,
  PageDown: true
}

export function isNavigationKey(key: string): key is NavigationKey {
  return key in NAVIGATION_KEY_SET
}

export type NavigationHandlers = {
  moveSelection: (targetPath: string, mode: SelectionMode) => void
  toggleDir: (worktreeId: string, dirPath: string) => void
  scrollToIndex: (index: number) => void
  focusRowAtIndex: (index: number) => void
}

export type NavigationContext = {
  rowProjection: FileExplorerRowProjection
  activeWorktreeId: string | null
  selectedNode: TreeNode | null
  isExpanded: (path: string) => boolean
  canToggleDirectories?: boolean
  findFocusedIndex: () => number | null
  handlers: NavigationHandlers
}

/** Move/reveal selection or toggle a directory; return whether the key was handled. */
export function applyFileExplorerNavigation(ctx: NavigationContext, e: KeyboardEvent): boolean {
  if (e.altKey || e.metaKey || e.ctrlKey) {
    return false
  }
  if (!isNavigationKey(e.key)) {
    return false
  }
  const total = ctx.rowProjection.getVisibleCount()
  const focusedIndex = ctx.findFocusedIndex()
  const activePath = ctx.selectedNode?.path ?? null
  const activeIndex = activePath ? (ctx.rowProjection.getIndexByPath(activePath) ?? null) : null
  const currentIndex = focusedIndex ?? activeIndex

  const resolved = resolveFileExplorerNavigationTarget({
    key: e.key,
    currentIndex,
    rowProjection: ctx.rowProjection,
    total,
    isExpanded: ctx.isExpanded
  })

  if (resolved.type === 'unhandled' || resolved.type === 'no-op') {
    return false
  }

  if (resolved.type === 'toggle-expand' || resolved.type === 'toggle-collapse') {
    e.preventDefault()
    e.stopPropagation()
    // Projected/transient trees may disable changes to persisted expansion state.
    if (ctx.activeWorktreeId && ctx.canToggleDirectories !== false) {
      ctx.handlers.toggleDir(ctx.activeWorktreeId, resolved.dirPath)
    }
    return true
  }

  const targetNode = ctx.rowProjection.getRowAtIndex(resolved.targetIndex)
  if (!targetNode) {
    return false
  }

  e.preventDefault()
  e.stopPropagation()

  // Match tree selection conventions: bare arrows replace, Shift+arrows extend from the anchor.
  const mode: SelectionMode = e.shiftKey && currentIndex !== null ? 'range' : 'replace'
  ctx.handlers.moveSelection(targetNode.path, mode)

  // Focus the new row so subsequent arrows and existing Enter/Delete shortcuts follow the selection.
  requestAnimationFrame(() => {
    ctx.handlers.focusRowAtIndex(resolved.targetIndex)
    ctx.handlers.scrollToIndex(resolved.targetIndex)
  })
  return true
}
