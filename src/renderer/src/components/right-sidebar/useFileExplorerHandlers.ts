import { useCallback } from 'react'
import type React from 'react'
import type { RefObject } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import { toast } from 'sonner'
import type { TreeNode } from './file-explorer-types'
import { FILE_EXPLORER_DRAGGABLE_SELECTOR } from './file-explorer-drag-scroll-marker'
import type { DirToggleTiming } from './file-explorer-dir-toggle-timing'
import { translate } from '@/i18n/i18n'
import {
  getFileExplorerOwnerUnresolvedMessage,
  requireMatchingFileExplorerOperationRoute
} from './file-explorer-operation-owner'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'

type UseFileExplorerHandlersParams = {
  activeWorktreeId: string | null
  runtimeEnvironmentId?: string | null
  openFile: (
    params: {
      filePath: string
      relativePath: string
      worktreeId: string
      language: string
      mode: 'edit'
      runtimeEnvironmentId?: string | null
    },
    options?: {
      preview?: boolean
      suppressActiveRuntimeFallback?: boolean
      focusEditor?: boolean
    }
  ) => void
  makePreviewFilePermanent: (filePath: string) => void
  toggleDir: (worktreeId: string, dirPath: string) => void
  canToggleDirectories?: boolean
  loadDir: (
    dirPath: string,
    depth: number,
    options?: { force?: boolean; failOnError?: boolean }
  ) => Promise<boolean>
  statPath: (path: string) => Promise<{ isDirectory: boolean; escapesWorktree?: boolean }>
  markPathAsDirectory: (path: string) => void
  setSelectedPath: (path: string) => void
  scrollRef: RefObject<HTMLDivElement | null>
}

type UseFileExplorerHandlersReturn = {
  handleClick: (node: TreeNode, dirToggle?: DirToggleTiming) => void
  handleDoubleClick: (node: TreeNode) => void
  handleWheelCapture: (e: React.WheelEvent<HTMLDivElement>) => void
}

type OpenFileParams = Parameters<UseFileExplorerHandlersParams['openFile']>[0]
type OpenFileOptions = Parameters<UseFileExplorerHandlersParams['openFile']>[1]

export async function activateFileExplorerNode(args: {
  node: TreeNode
  activeWorktreeId: string | null
  runtimeEnvironmentId?: string | null
  openFile: (params: OpenFileParams, options?: OpenFileOptions) => void
  toggleDir: (worktreeId: string, dirPath: string) => void
  canToggleDirectories?: boolean
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
    canToggleDirectories = true,
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
    if (!canToggleDirectories) {
      return
    }
    toggleDir(activeWorktreeId, node.path)
    return
  }
  let escapesWorktree = false
  if (node.isSymlink) {
    // Why: symlink targets may live in macOS TCC-protected app data. Resolve
    // them only after the user explicitly activates the row.
    let target: { isDirectory: boolean; escapesWorktree?: boolean } | null = null
    try {
      target = await statPath(node.path)
    } catch {
      // Why: an unresolvable target can't be proven to be a directory; fall through so
      // the editor reports the real error instead of the click dead-ending here.
    }
    escapesWorktree = target?.escapesWorktree === true
    if (target?.isDirectory && escapesWorktree) {
      // Why: project listings stay inside the project, so a folder link out of it isn't followed.
      toast.error(
        translate(
          'auto.components.right.sidebar.useFileExplorerHandlers.folderLinksOutsideProject',
          "This folder links outside the project, so it can't be opened here."
        )
      )
      return
    }
    if (target?.isDirectory) {
      const loadedAsDirectory = await loadDir(node.path, node.depth, {
        force: true,
        failOnError: true
      })
      if (loadedAsDirectory) {
        markPathAsDirectory(node.path)
        if (canToggleDirectories) {
          toggleDir(activeWorktreeId, node.path)
        }
      } else {
        toast.error(
          translate(
            'auto.components.right.sidebar.useFileExplorerHandlers.32cd9fd991',
            'Cannot open symlink target'
          )
        )
      }
      return
    }
  }
  let fileRuntimeEnvironmentId: string | null
  try {
    const route = requireMatchingFileExplorerOperationRoute(activeWorktreeId, node.operationOwner)
    fileRuntimeEnvironmentId = runtimeTargetEnvironmentId(route.target)
  } catch {
    toast.error(getFileExplorerOwnerUnresolvedMessage())
    return
  }
  openFile(
    {
      filePath: node.path,
      // Why: a file link out of the project opens by its absolute path, as a file the user named,
      // so it reads the same before and after a restart instead of being refused as a project file.
      relativePath: escapesWorktree ? node.path : node.relativePath,
      worktreeId: activeWorktreeId,
      runtimeEnvironmentId: fileRuntimeEnvironmentId ?? undefined,
      language: detectLanguage(node.name),
      mode: 'edit'
    },
    {
      preview: true,
      // Why: activating an Explorer file is a focus handoff even if the rich
      // editor finishes mounting after the row receives browser focus.
      focusEditor: true,
      // Why: explicit local opens must not inherit the active runtime, so we
      // encode "no runtime owner" via the fallback-suppression option.
      suppressActiveRuntimeFallback: fileRuntimeEnvironmentId === null
    }
  )
}

export function useFileExplorerHandlers({
  activeWorktreeId,
  runtimeEnvironmentId,
  openFile,
  makePreviewFilePermanent,
  toggleDir,
  canToggleDirectories = true,
  loadDir,
  statPath,
  markPathAsDirectory,
  setSelectedPath,
  scrollRef
}: UseFileExplorerHandlersParams): UseFileExplorerHandlersReturn {
  const handleClick = useCallback(
    (node: TreeNode, dirToggle: DirToggleTiming = 'immediate') => {
      if (dirToggle === 'skip' && (node.isDirectory || node.isSymlink)) {
        // Why: rename owns this click. Symlink rows stay file-shaped until
        // activation, so isDirectory alone would stat and toggle again.
        setSelectedPath(node.path)
        return
      }
      void activateFileExplorerNode({
        node,
        activeWorktreeId,
        runtimeEnvironmentId,
        openFile,
        toggleDir,
        canToggleDirectories,
        loadDir,
        statPath,
        markPathAsDirectory,
        setSelectedPath
      })
    },
    [
      activeWorktreeId,
      runtimeEnvironmentId,
      canToggleDirectories,
      loadDir,
      markPathAsDirectory,
      openFile,
      statPath,
      toggleDir,
      setSelectedPath
    ]
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
      if (!(target instanceof Element) || !target.closest(FILE_EXPLORER_DRAGGABLE_SELECTOR)) {
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
