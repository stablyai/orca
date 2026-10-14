import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { TreeNode } from './file-explorer-types'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import type { LocalPathOpenOwner } from '@/lib/local-path-open-guard'
import {
  createEmptyFileExplorerSelection,
  createSingleFileExplorerSelection,
  formatFileExplorerPathsForClipboard,
  getFileExplorerSelectionMode,
  resolveFileExplorerSelectionRows,
  updateFileExplorerSelection,
  updateFileExplorerSelectionPaths,
  type FileExplorerSelectionMode,
  type FileExplorerSelectionState
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
  isMac: boolean,
  pathOwner: LocalPathOpenOwner
): UseFileExplorerSelectionResult {
  const [selectionState, setSelectionState] = useState(createEmptyFileExplorerSelection)
  const visibleSelection = useMemo(
    () =>
      resolveFileExplorerSelectionRows(
        selectionState,
        (path) => rowProjection.getRowByPath(path)?.path
      ),
    [rowProjection, selectionState]
  )
  const selectionStateRef = useRef(visibleSelection)
  const rowProjectionRef = useRef(rowProjection)
  const pathOwnerRef = useRef(pathOwner)
  selectionStateRef.current = visibleSelection
  rowProjectionRef.current = rowProjection
  useLayoutEffect(() => {
    pathOwnerRef.current = pathOwner
  }, [pathOwner])
  const toVisibleRows = useCallback(
    (state: FileExplorerSelectionState) =>
      resolveFileExplorerSelectionRows(
        state,
        (path) => rowProjectionRef.current.getRowByPath(path)?.path
      ),
    []
  )

  const setSingleSelectedPath = useCallback((value: React.SetStateAction<string | null>) => {
    setSelectionState((prev) => {
      if (typeof value === 'function') {
        // Apply legacy single-path cleanup across the full selection to prune stale multi-selections.
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

  const moveSelection = useCallback(
    (targetPath: string, mode: FileExplorerSelectionMode) => {
      const orderedPaths = mode === 'replace' ? [] : rowProjectionRef.current.getOrderedPaths()
      setSelectionState((prev) =>
        updateFileExplorerSelection(toVisibleRows(prev), orderedPaths, targetPath, mode)
      )
    },
    [toVisibleRows]
  )

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

      // Build order only for modifier selection; frequent large-repo refreshes do not need it.
      const orderedPaths = rowProjectionRef.current.getOrderedPaths()
      setSelectionState((prev) =>
        updateFileExplorerSelection(toVisibleRows(prev), orderedPaths, node.path, selectionMode)
      )
    },
    [isMac, toVisibleRows]
  )

  const preserveSelectionForContextMenu = useCallback(
    (node: TreeNode) => {
      // Preserve right-clicked multi-selections; outside targets become a single-item selection.
      setSelectionState((prev) =>
        toVisibleRows(prev).selectedPaths.has(node.path)
          ? prev
          : createSingleFileExplorerSelection(node.path)
      )
    },
    [toVisibleRows]
  )

  const copyPathsForNode = useCallback((node: TreeNode, pathKind: 'absolute' | 'relative') => {
    const { selectedPaths } = selectionStateRef.current
    const selectedNodes = selectedPaths.has(node.path)
      ? rowProjectionRef.current.getRowsByPaths(selectedPaths)
      : []
    const actionNodes = selectedNodes.length > 0 ? selectedNodes : [node]
    void window.api.ui.writeClipboardText(
      formatFileExplorerPathsForClipboard(actionNodes, pathKind, pathOwnerRef.current)
    )
  }, [])

  return {
    selectedPath: visibleSelection.activePath,
    selectedPaths: visibleSelection.selectedPaths,
    setSingleSelectedPath,
    setSelectedPaths,
    resetSelection,
    selectRowWithModifiers,
    moveSelection,
    preserveSelectionForContextMenu,
    copyPathsForNode
  }
}
