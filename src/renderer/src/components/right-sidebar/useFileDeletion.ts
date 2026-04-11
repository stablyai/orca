import { useCallback, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { dirname } from '@/lib/path'
import { isPathEqualOrDescendant } from './file-explorer-paths'
import type { PendingDelete, TreeNode } from './file-explorer-types'
import { requestEditorSaveQuiesce } from '@/components/editor/editor-autosave'

type UseFileDeletionParams = {
  activeWorktreeId: string | null
  openFiles: {
    id: string
    filePath: string
  }[]
  closeFile: (fileId: string) => void
  refreshDir: (dirPath: string) => Promise<void>
  selectedPath: string | null
  setSelectedPath: Dispatch<SetStateAction<string | null>>
  isMac: boolean
  isWindows: boolean
}

type UseFileDeletionResult = {
  pendingDelete: PendingDelete | null
  isDeleting: boolean
  deleteShortcutLabel: string
  deleteActionLabel: string
  deleteDescription: string
  requestDelete: (node: TreeNode) => void
  closeDeleteDialog: () => void
  confirmDelete: () => Promise<void>
}

function getDeleteDescription(pendingDelete: PendingDelete | null, isWindows: boolean): string {
  if (!pendingDelete) {
    return ''
  }

  const destination = isWindows ? 'the Recycle Bin' : 'the Trash'
  const { node } = pendingDelete

  if (node.isDirectory) {
    return `Are you sure you want to move '${node.name}' and its contents to ${destination}?`
  }

  return `Are you sure you want to move '${node.name}' to ${destination}?`
}

export function useFileDeletion({
  activeWorktreeId,
  openFiles,
  closeFile,
  refreshDir,
  selectedPath,
  setSelectedPath,
  isMac,
  isWindows
}: UseFileDeletionParams): UseFileDeletionResult {
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const requestDelete = useCallback(
    (node: TreeNode) => {
      setSelectedPath(node.path)
      setPendingDelete({ node })
    },
    [setSelectedPath]
  )

  const closeDeleteDialog = useCallback(() => {
    setPendingDelete(null)
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) {
      return
    }

    const { node } = pendingDelete
    setIsDeleting(true)

    try {
      const filesToClose = openFiles.filter((file) =>
        isPathEqualOrDescendant(file.filePath, node.path)
      )
      // Why: moving a file to Trash/Recycle Bin is another external mutation of
      // the file path. Let any in-flight autosave finish first so the delete
      // action cannot be undone by a trailing write that recreates the file.
      await Promise.all(filesToClose.map((file) => requestEditorSaveQuiesce({ fileId: file.id })))

      await window.api.fs.deletePath({ targetPath: node.path })

      for (const file of filesToClose) {
        closeFile(file.id)
      }

      if (activeWorktreeId) {
        useAppStore.setState((state) => {
          const currentExpanded = state.expandedDirs[activeWorktreeId] ?? new Set<string>()
          const nextExpanded = new Set(
            Array.from(currentExpanded).filter(
              (dirPath) => !isPathEqualOrDescendant(dirPath, node.path)
            )
          )

          if (nextExpanded.size === currentExpanded.size) {
            return state
          }

          return {
            expandedDirs: {
              ...state.expandedDirs,
              [activeWorktreeId]: nextExpanded
            }
          }
        })
      }

      setPendingDelete(null)
      if (selectedPath && isPathEqualOrDescendant(selectedPath, node.path)) {
        setSelectedPath(null)
      }
      // Why: use targeted refreshDir instead of refreshTree so only the parent
      // directory is reloaded, preserving scroll position and avoiding redundant
      // full-tree reloads (the watcher will also trigger a targeted refresh).
      await refreshDir(dirname(node.path))
    } catch (error) {
      const action = isWindows ? 'move to Recycle Bin' : 'move to Trash'
      toast.error(error instanceof Error ? error.message : `Failed to ${action} '${node.name}'.`)
    } finally {
      setIsDeleting(false)
    }
  }, [
    activeWorktreeId,
    closeFile,
    isWindows,
    openFiles,
    pendingDelete,
    refreshDir,
    selectedPath,
    setSelectedPath
  ])

  const deleteActionLabel = isWindows ? 'Move to Recycle Bin' : 'Move to Trash'

  return useMemo(
    () => ({
      pendingDelete,
      isDeleting,
      deleteShortcutLabel: isMac ? '⌘⌫' : 'Del',
      deleteActionLabel,
      deleteDescription: getDeleteDescription(pendingDelete, isWindows),
      requestDelete,
      closeDeleteDialog,
      confirmDelete
    }),
    [
      closeDeleteDialog,
      confirmDelete,
      deleteActionLabel,
      isMac,
      isDeleting,
      isWindows,
      pendingDelete,
      requestDelete
    ]
  )
}
