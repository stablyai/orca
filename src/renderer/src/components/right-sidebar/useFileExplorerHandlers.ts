import { useCallback } from 'react'
import type React from 'react'
import type { RefObject } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import type { TreeNode } from './file-explorer-types'

function toFileUrl(filePath: string): string {
  const normalizedPath = filePath.replaceAll('\\', '/')
  const segments = normalizedPath.split('/').map((segment, index) => {
    if (index === 0 && /^[A-Za-z]:$/.test(segment)) {
      return segment
    }
    return encodeURIComponent(segment)
  })

  if (normalizedPath.startsWith('/')) {
    return `file://${segments.join('/')}`
  }

  return `file:///${segments.join('/')}`
}

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
  createBrowserTab: (worktreeId: string, url: string, options?: { title?: string }) => void
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
  scrollRef,
  createBrowserTab
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
      const language = detectLanguage(node.name)
      if (language === 'html') {
        // Open HTML files in the built-in browser pane instead of the editor
        // so the user sees the rendered page rather than source markup.
        createBrowserTab(activeWorktreeId, toFileUrl(node.path))
        return
      }
      openFile({
        filePath: node.path,
        relativePath: node.relativePath,
        worktreeId: activeWorktreeId,
        language,
        mode: 'edit'
      })
    },
    [activeWorktreeId, openFile, toggleDir, setSelectedPath, createBrowserTab]
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
