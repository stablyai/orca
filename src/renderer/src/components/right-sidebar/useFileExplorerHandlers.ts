import { useCallback, useEffect, useRef } from 'react'
import type React from 'react'
import type { RefObject } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import { toast } from 'sonner'
import type { TreeNode } from './file-explorer-types'
import { FILE_EXPLORER_DRAGGABLE_SELECTOR } from './file-explorer-drag-scroll-marker'
import { DIR_TOGGLE_DOUBLE_CLICK_MS } from './file-explorer-dir-toggle-timing'
import type { DirToggleTiming } from './file-explorer-dir-toggle-timing'
import { translate } from '@/i18n/i18n'
import {
  getFileExplorerOwnerUnresolvedMessage,
  requireMatchingFileExplorerOperationRoute
} from './file-explorer-operation-owner'

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
  statPath: (path: string) => Promise<{ isDirectory: boolean }>
  authorizeExternalPath: (args: { targetPath: string }) => Promise<void>
  markPathAsDirectory: (path: string) => void
  setSelectedPath: (path: string) => void
  scrollRef: RefObject<HTMLDivElement | null>
}

type UseFileExplorerHandlersReturn = {
  handleClick: (node: TreeNode, dirToggle?: DirToggleTiming) => void
  handleDoubleClick: (node: TreeNode) => void
  handleWheelCapture: (e: React.WheelEvent<HTMLDivElement>) => void
  cancelPendingDirToggle: () => void
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
  authorizeExternalPath: UseFileExplorerHandlersParams['authorizeExternalPath']
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
    authorizeExternalPath,
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
  if (node.isSymlink) {
    // Why: symlink targets may live in macOS TCC-protected app data. Resolve
    // them only after the user explicitly activates the row.
    let targetIsDirectory = false
    try {
      // Why: activation is explicit intent to follow the link, so grant its target the
      // access a terminal-link click already grants. Remote owners skip it — the
      // relay/runtime is their security boundary.
      if (node.operationOwner?.kind === 'local') {
        await authorizeExternalPath({ targetPath: node.path })
      }
      targetIsDirectory = (await statPath(node.path)).isDirectory
    } catch {
      // Why: an unresolvable target can't be proven to be a directory; fall through so
      // the editor reports the real error instead of the click dead-ending here.
    }
    if (targetIsDirectory) {
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
    fileRuntimeEnvironmentId = route.settings.activeRuntimeEnvironmentId?.trim() || null
  } catch {
    toast.error(getFileExplorerOwnerUnresolvedMessage())
    return
  }
  openFile(
    {
      filePath: node.path,
      relativePath: node.relativePath,
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
  authorizeExternalPath,
  markPathAsDirectory,
  setSelectedPath,
  scrollRef
}: UseFileExplorerHandlersParams): UseFileExplorerHandlersReturn {
  const pendingDirToggle = useRef<{
    timer: ReturnType<typeof setTimeout>
    dirPath: string
    run: () => void
  } | null>(null)

  const cancelPendingDirToggle = useCallback((): void => {
    if (pendingDirToggle.current === null) {
      return
    }
    clearTimeout(pendingDirToggle.current.timer)
    pendingDirToggle.current = null
  }, [])

  // Why: only the row that armed the deferral can retract it (its own second
  // click becomes a rename). Any other gesture leaves that click's intent
  // standing, so run it now instead of dropping the folder the user opened.
  const settlePendingDirToggle = useCallback((retractingDirPath: string | null): void => {
    const pending = pendingDirToggle.current
    if (pending === null) {
      return
    }
    clearTimeout(pending.timer)
    pendingDirToggle.current = null
    if (pending.dirPath !== retractingDirPath) {
      pending.run()
    }
  }, [])

  useEffect(() => cancelPendingDirToggle, [cancelPendingDirToggle])

  const handleClick = useCallback(
    (node: TreeNode, dirToggle: DirToggleTiming = 'immediate') => {
      settlePendingDirToggle(node.path)
      if (dirToggle === 'skip' && node.isDirectory) {
        // Why: the rename about to start owns this gesture; selection still applies.
        setSelectedPath(node.path)
        return
      }
      void activateFileExplorerNode({
        node,
        activeWorktreeId,
        runtimeEnvironmentId,
        openFile,
        toggleDir:
          dirToggle === 'deferred'
            ? (worktreeId, dirPath) => {
                const run = (): void => toggleDir(worktreeId, dirPath)
                pendingDirToggle.current = {
                  dirPath,
                  run,
                  timer: setTimeout(() => {
                    pendingDirToggle.current = null
                    run()
                  }, DIR_TOGGLE_DOUBLE_CLICK_MS)
                }
              }
            : toggleDir,
        canToggleDirectories,
        loadDir,
        statPath,
        authorizeExternalPath,
        markPathAsDirectory,
        setSelectedPath
      })
    },
    [
      activeWorktreeId,
      runtimeEnvironmentId,
      canToggleDirectories,
      settlePendingDirToggle,
      loadDir,
      markPathAsDirectory,
      openFile,
      statPath,
      authorizeExternalPath,
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

  return { handleClick, handleDoubleClick, handleWheelCapture, cancelPendingDirToggle }
}
