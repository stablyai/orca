import type { TreeNode } from './file-explorer-types'

export type FileExplorerSelectionState = {
  activePath: string | null
  anchorPath: string | null
  selectedPaths: Set<string>
}

export type FileExplorerSelectionMode = 'replace' | 'toggle' | 'range' | 'additive-range'

export type FileExplorerSelectionModifiers = {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export function createEmptyFileExplorerSelection(): FileExplorerSelectionState {
  return {
    activePath: null,
    anchorPath: null,
    selectedPaths: new Set()
  }
}

export function createSingleFileExplorerSelection(path: string | null): FileExplorerSelectionState {
  return {
    activePath: path,
    anchorPath: path,
    selectedPaths: path ? new Set([path]) : new Set()
  }
}

export function getFileExplorerSelectionMode(
  modifiers: FileExplorerSelectionModifiers,
  isMac: boolean
): FileExplorerSelectionMode {
  const hasToggleModifier = isMac ? modifiers.metaKey : modifiers.ctrlKey
  if (modifiers.shiftKey && hasToggleModifier) {
    return 'additive-range'
  }
  if (modifiers.shiftKey) {
    return 'range'
  }
  if (hasToggleModifier) {
    return 'toggle'
  }
  return 'replace'
}

function firstSelectedPathInTreeOrder(
  selectedPaths: Set<string>,
  orderedPaths: readonly string[]
): string | null {
  return orderedPaths.find((path) => selectedPaths.has(path)) ?? null
}

function getRangePaths(
  orderedPaths: readonly string[],
  anchorPath: string | null,
  targetPath: string
): string[] {
  const targetIndex = orderedPaths.indexOf(targetPath)
  const anchorIndex = anchorPath ? orderedPaths.indexOf(anchorPath) : -1
  if (targetIndex === -1 || anchorIndex === -1) {
    return [targetPath]
  }

  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  return orderedPaths.slice(start, end + 1)
}

export function updateFileExplorerSelection(
  current: FileExplorerSelectionState,
  orderedPaths: readonly string[],
  targetPath: string,
  mode: FileExplorerSelectionMode
): FileExplorerSelectionState {
  if (mode === 'replace') {
    return createSingleFileExplorerSelection(targetPath)
  }

  if (mode === 'toggle') {
    const selectedPaths = new Set(current.selectedPaths)
    if (selectedPaths.has(targetPath)) {
      selectedPaths.delete(targetPath)
    } else {
      selectedPaths.add(targetPath)
    }

    const activePath = selectedPaths.has(targetPath)
      ? targetPath
      : firstSelectedPathInTreeOrder(selectedPaths, orderedPaths)
    return {
      activePath,
      anchorPath: activePath,
      selectedPaths
    }
  }

  const rangeAnchor =
    current.anchorPath && orderedPaths.includes(current.anchorPath)
      ? current.anchorPath
      : targetPath
  const rangePaths = getRangePaths(orderedPaths, rangeAnchor, targetPath)
  const selectedPaths =
    mode === 'additive-range' ? new Set(current.selectedPaths) : new Set<string>()
  for (const path of rangePaths) {
    selectedPaths.add(path)
  }

  return {
    activePath: targetPath,
    anchorPath: rangeAnchor,
    selectedPaths
  }
}

export function updateFileExplorerSelectionPaths(
  current: FileExplorerSelectionState,
  updatePath: (path: string) => string | null
): FileExplorerSelectionState {
  const updatedPathByPath = new Map<string, string | null>()
  const getUpdatedPath = (path: string | null): string | null => {
    if (path === null) {
      return null
    }
    if (!updatedPathByPath.has(path)) {
      updatedPathByPath.set(path, updatePath(path))
    }
    return updatedPathByPath.get(path) ?? null
  }

  let changed = false
  const selectedPaths = new Set<string>()
  for (const path of current.selectedPaths) {
    const nextPath = getUpdatedPath(path)
    if (nextPath !== path) {
      changed = true
    }
    if (nextPath !== null) {
      selectedPaths.add(nextPath)
    }
  }

  const updatedActivePath = getUpdatedPath(current.activePath)
  const activePath =
    updatedActivePath && selectedPaths.has(updatedActivePath)
      ? updatedActivePath
      : (selectedPaths.values().next().value ?? null)
  const updatedAnchorPath = getUpdatedPath(current.anchorPath)
  const anchorPath =
    updatedAnchorPath && selectedPaths.has(updatedAnchorPath) ? updatedAnchorPath : activePath

  if (
    !changed &&
    activePath === current.activePath &&
    anchorPath === current.anchorPath &&
    selectedPaths.size === current.selectedPaths.size
  ) {
    return current
  }

  return {
    activePath,
    anchorPath,
    selectedPaths
  }
}

export function getFileExplorerActionNodes(
  flatRows: readonly TreeNode[],
  selectedPaths: Set<string>,
  fallbackNode: TreeNode
): TreeNode[] {
  if (!selectedPaths.has(fallbackNode.path)) {
    return [fallbackNode]
  }

  const selectedNodes = flatRows.filter((node) => selectedPaths.has(node.path))
  return selectedNodes.length > 0 ? selectedNodes : [fallbackNode]
}

export function countVisibleFileExplorerSelections(
  flatRows: readonly TreeNode[],
  selectedPaths: Set<string>
): number {
  if (selectedPaths.size <= 1) {
    return selectedPaths.size
  }

  return flatRows.reduce((count, node) => count + (selectedPaths.has(node.path) ? 1 : 0), 0)
}

export function formatFileExplorerPathsForClipboard(
  nodes: readonly TreeNode[],
  pathKind: 'absolute' | 'relative'
): string {
  return nodes.map((node) => (pathKind === 'absolute' ? node.path : node.relativePath)).join('\n')
}
