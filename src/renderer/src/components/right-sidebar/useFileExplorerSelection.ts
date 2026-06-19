import { useCallback, useRef, useState } from 'react'
import type React from 'react'
import type { TreeNode } from './file-explorer-types'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import {
  createEmptyFileExplorerSelection,
  createSingleFileExplorerSelection,
  formatFileExplorerPathsForClipboard,
  getFileExplorerSelectionMode,
  updateFileExplorerSelection,
  updateFileExplorerSelectionPaths,
  type FileExplorerSelectionMode
} from './file-explorer-selection'

type UseFileExplorerSelectionResult = {
  selectedPath: string | null
  selectedPaths: Set<string>
  setSingleSelectedPath: React.Dispatch<React.SetStateAction<string | null>>
  setSelectedPaths: (paths: Set<string>) => void
  resetSelection: () => void
  selectRowWithModifiers: (
    node: TreeNode,
    event: React.MouseEvent<HTMLButtonElement>,
    onReplaceClick: (node: TreeNode) => void
  ) => void
  moveSelection: (targetPath: string, mode: FileExplorerSelectionMode) => void
  preserveSelectionForContextMenu: (node: TreeNode) => void
  copyPathsForNode: (node: TreeNode, pathKind: 'absolute' | 'relative') => void
}

export function useFileExplorerSelection(
  rowProjection: FileExplorerRowProjection,
  isMac: boolean
): UseFileExplorerSelectionResult {
  const [selectionState, setSelectionState] = useState(createEmptyFileExplorerSelection)
  const selectionStateRef = useRef(selectionState)
  const rowProjectionRef = useRef(rowProjection)
  selectionStateRef.current = selectionState
  rowProjectionRef.current = rowProjection

  const setSingleSelectedPath = useCallback((value: React.SetStateAction<string | null>) => {
    setSelectionState((prev) => {
      if (typeof value === 'function') {
        // Why: legacy watcher cleanup still speaks in single-path updater terms;
        // apply it across the whole selected set so stale multi-selections converge.
        return updateFileExplorerSelectionPaths(prev, value)
      }
      const nextPath = value
      return createSingleFileExplorerSelection(nextPath)
    })
  }, [])

  const resetSelection = useCallback(() => {
    setSelectionState(createEmptyFileExplorerSelection())
  }, [])

  const setSelectedPaths = useCallback((paths: Set<string>) => {
    setSelectionState((prev) => {
      const nextActive = paths.has(prev.activePath ?? '')
        ? prev.activePath
        : paths.size > 0
          ? [...paths][0]
          : null
      return { activePath: nextActive, anchorPath: nextActive, selectedPaths: paths }
    })
  }, [])

  const moveSelection = useCallback((targetPath: string, mode: FileExplorerSelectionMode) => {
    const orderedPaths = rowProjectionRef.current.getOrderedPaths()
    setSelectionState((prev) => updateFileExplorerSelection(prev, orderedPaths, targetPath, mode))
  }, [])

  const selectRowWithModifiers = useCallback(
    (
      node: TreeNode,
      event: React.MouseEvent<HTMLButtonElement>,
      onReplaceClick: (node: TreeNode) => void
    ) => {
      const selectionMode = getFileExplorerSelectionMode(
        {
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey
        },
        isMac
      )

      if (selectionMode === 'replace') {
        onReplaceClick(node)
        return
      }

      // Why: tree refreshes are much more common than range/toggle selections
      // in large repos. Build order only for the modifier path that needs it.
      const orderedPaths = rowProjectionRef.current.getOrderedPaths()
      setSelectionState((prev) =>
        updateFileExplorerSelection(prev, orderedPaths, node.path, selectionMode)
      )
    },
    [isMac]
  )

  const preserveSelectionForContextMenu = useCallback((node: TreeNode) => {
    // Why: right-clicking an existing multi-selection should keep the copy
    // target set; right-clicking outside it should behave like a single item.
    setSelectionState((prev) =>
      prev.selectedPaths.has(node.path) ? prev : createSingleFileExplorerSelection(node.path)
    )
  }, [])

  const copyPathsForNode = useCallback((node: TreeNode, pathKind: 'absolute' | 'relative') => {
    const { selectedPaths } = selectionStateRef.current
    const selectedNodes = selectedPaths.has(node.path)
      ? rowProjectionRef.current.getRowsByPaths(selectedPaths)
      : []
    const actionNodes = selectedNodes.length > 0 ? selectedNodes : [node]
    void window.api.ui.writeClipboardText(
      formatFileExplorerPathsForClipboard(actionNodes, pathKind)
    )
  }, [])

  return {
    selectedPath: selectionState.activePath,
    selectedPaths: selectionState.selectedPaths,
    setSingleSelectedPath,
    setSelectedPaths,
    resetSelection,
    selectRowWithModifiers,
    moveSelection,
    preserveSelectionForContextMenu,
    copyPathsForNode
  }
}
