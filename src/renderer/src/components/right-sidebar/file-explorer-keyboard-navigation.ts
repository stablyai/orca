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

/**
 * Resolve a tree-navigation key to a target row index, mirroring the VS Code
 * Explorer tree: arrow keys move within the flat visible order, Left/Right
 * collapse/expand folders or step across parent/child boundaries, and
 * Home/End/PageUp/PageDown jump along the visible list.
 */
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
  findFocusedIndex: () => number | null
  handlers: NavigationHandlers
}

/**
 * Apply a tree-navigation key to the explorer: resolve the target, then
 * move the selection (or toggle a directory) and bring the new row into
 * view. Returns true if the key was handled.
 */
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
    if (ctx.activeWorktreeId) {
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

  // Why: VS Code replaces the selection on bare arrow keys and extends
  // it (from the anchor) on Shift+arrow. We translate the modifier into
  // the same selection modes the click handler uses.
  const mode: SelectionMode = e.shiftKey && currentIndex !== null ? 'range' : 'replace'
  ctx.handlers.moveSelection(targetNode.path, mode)

  // Why: focusing the row button keeps subsequent arrow keys anchored to
  // the new row and lets the existing Enter/Delete shortcuts pick it up
  // without a separate focus call from the caller. Scroll first so the
  // virtualizer has a chance to mount the target wrapper; otherwise on a
  // large jump the focus query misses, the previously-focused button then
  // unmounts as it scrolls out of overscan, focus falls to <body>, and the
  // focusInExplorer() gate silently swallows every following keypress.
  ctx.handlers.scrollToIndex(resolved.targetIndex)
  requestAnimationFrame(() => {
    ctx.handlers.focusRowAtIndex(resolved.targetIndex)
  })
  return true
}
