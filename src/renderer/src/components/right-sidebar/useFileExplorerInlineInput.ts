import { useCallback, useMemo, useState } from 'react'
import type React from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { dirname, joinPath } from '@/lib/path'
import { getConnectionId } from '@/lib/connection-context'
import { extractIpcErrorMessage, renameFileOnDisk } from '@/lib/rename-file'
import type { InlineInput } from './FileExplorerRow'
import type { TreeNode } from './file-explorer-types'
import { commitFileExplorerOp } from './fileExplorerUndoRedo'

type UseFileExplorerInlineInputParams = {
  activeWorktreeId: string | null
  worktreePath: string | null
  expanded: Set<string>
  flatRows: TreeNode[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  refreshDir: (dirPath: string) => Promise<void>
}

type UseFileExplorerInlineInputResult = {
  inlineInput: InlineInput | null
  inlineInputIndex: number
  startNew: (type: 'file' | 'folder', parentPath: string, depth: number) => void
  startRename: (node: TreeNode) => void
  dismissInlineInput: () => void
  handleInlineSubmit: (value: string) => void
}

export function useFileExplorerInlineInput({
  activeWorktreeId,
  worktreePath,
  expanded,
  flatRows,
  scrollRef,
  refreshDir
}: UseFileExplorerInlineInputParams): UseFileExplorerInlineInputResult {
  const toggleDir = useAppStore((s) => s.toggleDir)
  const openFile = useAppStore((s) => s.openFile)
  const [inlineInput, setInlineInput] = useState<InlineInput | null>(null)

  const inlineInputIndex = useMemo(() => {
    if (!inlineInput || inlineInput.type === 'rename') {
      return -1
    }
    const parentPath = inlineInput.parentPath
    let last = -1
    for (let i = 0; i < flatRows.length; i++) {
      const rowPath = flatRows[i].path
      // Match the parent itself and any descendants (handle both / and \ separators)
      if (
        rowPath === parentPath ||
        rowPath.startsWith(`${parentPath}/`) ||
        rowPath.startsWith(`${parentPath}\\`)
      ) {
        last = i
      }
    }
    if (last >= 0) {
      return last + 1
    }
    // Empty root directory — place at the top
    if (parentPath === worktreePath) {
      return 0
    }
    // Collapsed non-root parent — place right after the parent row
    const parentIndex = flatRows.findIndex((row) => row.path === parentPath)
    return parentIndex >= 0 ? parentIndex + 1 : 0
  }, [inlineInput, flatRows, worktreePath])

  const startNew = useCallback(
    (type: 'file' | 'folder', parentPath: string, depth: number) => {
      if (activeWorktreeId && parentPath !== worktreePath && !expanded.has(parentPath)) {
        toggleDir(activeWorktreeId, parentPath)
      }
      setInlineInput({ parentPath, type, depth })
    },
    [activeWorktreeId, worktreePath, expanded, toggleDir]
  )

  const startRename = useCallback(
    (node: TreeNode) =>
      setInlineInput({
        parentPath: dirname(node.path),
        type: 'rename',
        depth: node.depth,
        existingName: node.name,
        existingPath: node.path
      }),
    []
  )

  const dismissInlineInput = useCallback(() => {
    setInlineInput(null)
    requestAnimationFrame(() => scrollRef.current?.focus())
  }, [scrollRef])

  const handleInlineSubmit = useCallback(
    (value: string) => {
      if (!inlineInput || !value.trim() || !activeWorktreeId || !worktreePath) {
        setInlineInput(null)
        return
      }
      const name = value.trim()
      // No-op if the user submitted the same name (e.g. blur without editing)
      if (inlineInput.type === 'rename' && name === inlineInput.existingName) {
        setInlineInput(null)
        return
      }
      const run = async (): Promise<void> => {
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        if (inlineInput.type === 'rename' && inlineInput.existingPath) {
          await renameFileOnDisk({
            oldPath: inlineInput.existingPath,
            newName: name,
            worktreeId: activeWorktreeId,
            worktreePath,
            refreshDir
          })
        } else {
          const fullPath = joinPath(inlineInput.parentPath, name)
          try {
            await (inlineInput.type === 'folder'
              ? window.api.fs.createDir({ dirPath: fullPath, connectionId })
              : window.api.fs.createFile({ filePath: fullPath, connectionId }))
            const parentForRefresh = inlineInput.parentPath
            if (inlineInput.type === 'folder') {
              commitFileExplorerOp({
                undo: async () => {
                  await window.api.fs.deletePath({ targetPath: fullPath, connectionId })
                  await refreshDir(parentForRefresh)
                },
                redo: async () => {
                  await window.api.fs.createDir({ dirPath: fullPath, connectionId })
                  await refreshDir(parentForRefresh)
                }
              })
            } else {
              commitFileExplorerOp({
                undo: async () => {
                  await window.api.fs.deletePath({ targetPath: fullPath, connectionId })
                  await refreshDir(parentForRefresh)
                },
                redo: async () => {
                  await window.api.fs.createFile({ filePath: fullPath, connectionId })
                  await refreshDir(parentForRefresh)
                }
              })
            }
            await refreshDir(inlineInput.parentPath)
            if (inlineInput.type === 'file') {
              openFile({
                filePath: fullPath,
                relativePath: worktreePath ? fullPath.slice(worktreePath.length + 1) : name,
                worktreeId: activeWorktreeId,
                language: detectLanguage(name),
                mode: 'edit'
              })
            }
          } catch (err) {
            // Refresh the directory even on failure so the tree stays consistent
            await refreshDir(inlineInput.parentPath)
            toast.error(extractIpcErrorMessage(err, `Failed to create '${name}'.`))
          }
        }
      }
      void run()
      setInlineInput(null)
      requestAnimationFrame(() => scrollRef.current?.focus())
    },
    [inlineInput, activeWorktreeId, worktreePath, refreshDir, openFile, scrollRef]
  )

  return {
    inlineInput,
    inlineInputIndex,
    startNew,
    startRename,
    dismissInlineInput,
    handleInlineSubmit
  }
}
