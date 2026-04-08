import { useCallback } from 'react'
import type React from 'react'
import type { RefObject } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import type { TreeNode } from './file-explorer-types'

type UseFileExplorerHandlersParams = {
  activeWorktreeId: string | null
  openFile: (params: {
    filePath: string
    relativePath: string
    worktreeId: string
    language: string
    mode: 'edit'
  }) => void
  pinFile: (filePath: string) => void
  toggleDir: (worktreeId: string, dirPath: string) => void
  setSelectedPath: (path: string) => void
  scrollRef: RefObject<HTMLDivElement | null>
}

type UseFileExplorerHandlersReturn = {
  handleClick: (node: TreeNode) => void
  handleDoubleClick: (node: TreeNode) => void
  handleWheelCapture: (e: React.WheelEvent<HTMLDivElement>) => void
}

export function useFileExplorerHandlers({
  activeWorktreeId,
  openFile,
  pinFile,
  toggleDir,
  setSelectedPath,
  scrollRef
}: UseFileExplorerHandlersParams): UseFileExplorerHandlersReturn {
  const handleClick = useCallback(
    (node: TreeNode) => {
      if (!activeWorktreeId) {
        return
      }
      setSelectedPath(node.path)
      if (node.isDirectory) {
        toggleDir(activeWorktreeId, node.path)
        return
      }
      openFile({
        filePath: node.path,
        relativePath: node.relativePath,
        worktreeId: activeWorktreeId,
        language: detectLanguage(node.name),
        mode: 'edit'
      })
    },
    [activeWorktreeId, openFile, toggleDir, setSelectedPath]
  )

  const handleDoubleClick = useCallback(
    (node: TreeNode) => {
      if (!activeWorktreeId || node.isDirectory) {
        return
      }
      pinFile(node.path)
    },
    [activeWorktreeId, pinFile]
  )

  const handleWheelCapture = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const container = scrollRef.current
      if (!container || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) {
        return
      }
      const target = e.target
      if (!(target instanceof Element) || !target.closest('[data-explorer-draggable="true"]')) {
        return
      }
      if (container.scrollHeight <= container.clientHeight) {
        return
      }
      e.preventDefault()
      container.scrollTop += e.deltaY
    },
    [scrollRef]
  )

  return { handleClick, handleDoubleClick, handleWheelCapture }
}
