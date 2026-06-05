import { useCallback } from 'react'
import type React from 'react'
import type { RefObject } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import { toast } from 'sonner'
import type { TreeNode } from './file-explorer-types'

type UseFileExplorerHandlersParams = {
  activeWorktreeId: string | null
  openFile: (
    params: {
      filePath: string
      relativePath: string
      worktreeId: string
      language: string
      mode: 'edit'
    },
    options?: { preview?: boolean }
  ) => void
  makePreviewFilePermanent: (filePath: string) => void
  toggleDir: (worktreeId: string, dirPath: string) => void
  loadDir: (
    dirPath: string,
    depth: number,
    options?: { force?: boolean; failOnError?: boolean }
  ) => Promise<boolean>
  statPath: (path: string) => Promise<{ isDirectory: boolean }>
  markPathAsDirectory: (path: string) => void
  setSelectedPath: (path: string) => void
  scrollRef: RefObject<HTMLDivElement | null>
}

type UseFileExplorerHandlersReturn = {
  handleClick: (node: TreeNode) => void
  handleDoubleClick: (node: TreeNode) => void
  handleWheelCapture: (e: React.WheelEvent<HTMLDivElement>) => void
}

type OpenFileParams = Parameters<UseFileExplorerHandlersParams['openFile']>[0]
type OpenFileOptions = Parameters<UseFileExplorerHandlersParams['openFile']>[1]

export async function activateFileExplorerNode(args: {
  node: TreeNode
  activeWorktreeId: string | null
  openFile: (params: OpenFileParams, options?: OpenFileOptions) => void
  toggleDir: (worktreeId: string, dirPath: string) => void
  loadDir: UseFileExplorerHandlersParams['loadDir']
  statPath: UseFileExplorerHandlersParams['statPath']
  markPathAsDirectory: (path: string) => void
  setSelectedPath: (path: string) => void
}): Promise<void> {
  const {
    node,
    activeWorktreeId,
    openFile,
    toggleDir,
    loadDir,
    statPath,
    markPathAsDirectory,
    setSelectedPath
  } = args
  if (!activeWorktreeId) {
    return
  }
  setSelectedPath(node.path)
  if (node.isDirectory) {
    toggleDir(activeWorktreeId, node.path)
    return
  }
  if (node.isSymlink) {
    // Why: symlink targets may live in macOS TCC-protected app data. Resolve
    // them only after the user explicitly activates the row.
    let targetIsDirectory = false
    try {
      targetIsDirectory = (await statPath(node.path)).isDirectory
    } catch {
      toast.error('Cannot open symlink target')
      return
    }
    if (targetIsDirectory) {
      const loadedAsDirectory = await loadDir(node.path, node.depth, {
        force: true,
        failOnError: true
      })
      if (loadedAsDirectory) {
        markPathAsDirectory(node.path)
        toggleDir(activeWorktreeId, node.path)
      } else {
        toast.error('Cannot open symlink target')
      }
      return
    }
  }
  openFile(
    {
      filePath: node.path,
      relativePath: node.relativePath,
      worktreeId: activeWorktreeId,
      language: detectLanguage(node.name),
      mode: 'edit'
    },
    { preview: true }
  )
}

export function useFileExplorerHandlers({
  activeWorktreeId,
  openFile,
  makePreviewFilePermanent,
  toggleDir,
  loadDir,
  statPath,
  markPathAsDirectory,
  setSelectedPath,
  scrollRef
}: UseFileExplorerHandlersParams): UseFileExplorerHandlersReturn {
  const handleClick = useCallback(
    (node: TreeNode) => {
      void activateFileExplorerNode({
        node,
        activeWorktreeId,
        openFile,
        toggleDir,
        loadDir,
        statPath,
        markPathAsDirectory,
        setSelectedPath
      })
    },
    [activeWorktreeId, loadDir, markPathAsDirectory, openFile, statPath, toggleDir, setSelectedPath]
  )

  const handleDoubleClick = useCallback(
    (node: TreeNode) => {
      if (!activeWorktreeId || node.isDirectory) {
        return
      }
      makePreviewFilePermanent(node.path)
    },
    [activeWorktreeId, makePreviewFilePermanent]
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
