import { useCallback, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { TreeNode } from './file-explorer-types'
import {
  createEmptyFileExplorerSelection,
  createSingleFileExplorerSelection,
  formatFileExplorerPathsForClipboard,
  getFileExplorerActionNodes,
  getFileExplorerSelectionMode,
  updateFileExplorerSelection,
  updateFileExplorerSelectionPaths
} from './file-explorer-selection'

type UseFileExplorerSelectionResult = {
  selectedPath: string | null
  selectedPaths: Set<string>
  setSingleSelectedPath: React.Dispatch<React.SetStateAction<string | null>>
  resetSelection: () => void
  selectRowWithModifiers: (
    node: TreeNode,
    event: React.MouseEvent<HTMLButtonElement>,
    onReplaceClick: (node: TreeNode) => void
  ) => void
  preserveSelectionForContextMenu: (node: TreeNode) => void
  copyPathsForNode: (node: TreeNode, pathKind: 'absolute' | 'relative') => void
}

export function useFileExplorerSelection(
  flatRows: TreeNode[],
  isMac: boolean
): UseFileExplorerSelectionResult {
  const [selectionState, setSelectionState] = useState(createEmptyFileExplorerSelection)
  const selectionStateRef = useRef(selectionState)
  const flatRowsRef = useRef(flatRows)
  selectionStateRef.current = selectionState
  flatRowsRef.current = flatRows

  const orderedPaths = useMemo(() => flatRows.map((row) => row.path), [flatRows])

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

      setSelectionState((prev) =>
        updateFileExplorerSelection(prev, orderedPaths, node.path, selectionMode)
      )
    },
    [isMac, orderedPaths]
  )

  const preserveSelectionForContextMenu = useCallback((node: TreeNode) => {
    // Why: right-clicking an existing multi-selection should keep the copy
    // target set; right-clicking outside it should behave like a single item.
    setSelectionState((prev) =>
      prev.selectedPaths.has(node.path) ? prev : createSingleFileExplorerSelection(node.path)
    )
  }, [])

  const copyPathsForNode = useCallback((node: TreeNode, pathKind: 'absolute' | 'relative') => {
    const actionNodes = getFileExplorerActionNodes(
      flatRowsRef.current,
      selectionStateRef.current.selectedPaths,
      node
    )
    void window.api.ui.writeClipboardText(
      formatFileExplorerPathsForClipboard(actionNodes, pathKind)
    )
  }, [])

  return {
    selectedPath: selectionState.activePath,
    selectedPaths: selectionState.selectedPaths,
    setSingleSelectedPath,
    resetSelection,
    selectRowWithModifiers,
    preserveSelectionForContextMenu,
    copyPathsForNode
  }
}
