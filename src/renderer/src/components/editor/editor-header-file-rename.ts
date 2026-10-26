import { useCallback, useRef, useState } from 'react'
import type { RefCallback } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { useWorktreeById } from '@/store/selectors'
import { basename } from '@/lib/path'
import { renameFileOnDisk } from '@/lib/rename-file'
import { getUntitledFileRoot } from './untitled-file-rename-path'
import { useAppStore } from '@/store'
import { editorTabDocumentFolderAccess } from '@/lib/local-file-access'

type EditorHeaderFileRenameState = {
  canRename: boolean
  currentFileName: string
  isRenaming: boolean
  renameInputRef: RefCallback<HTMLInputElement>
  openRenameInput: () => void
  commitRename: () => void
  cancelRename: () => void
}

export function useEditorHeaderFileRename(activeFile: OpenFile): EditorHeaderFileRenameState {
  const worktree = useWorktreeById(activeFile.worktreeId)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameFilePath, setRenameFilePath] = useState(activeFile.filePath)
  const renameInputElementRef = useRef<HTMLInputElement | null>(null)
  const renameFocusFrameRef = useRef<number | null>(null)
  // Escape unmounts the focused input and triggers blur; suppress that trailing commit so cancellation cannot rename.
  const renameCancelledRef = useRef(false)
  // The header is unkeyed across files; cancel stale rename intent before it can target a new path.
  if (renameFilePath !== activeFile.filePath) {
    renameCancelledRef.current = true
    setRenameFilePath(activeFile.filePath)
    setIsRenaming(false)
  }
  const currentFileName = basename(activeFile.filePath)
  // Renaming read-only tabs would mutate provider-owned artifact paths.
  const canRename =
    activeFile.mode === 'edit' &&
    !activeFile.diffSource &&
    !activeFile.conflict &&
    !activeFile.readOnly &&
    !isRenaming

  const openRenameInput = (): void => {
    if (!canRename) {
      return
    }
    renameCancelledRef.current = false
    setIsRenaming(true)
  }

  const commitRename = (): void => {
    if (renameCancelledRef.current) {
      setIsRenaming(false)
      return
    }
    const input = renameInputElementRef.current
    if (!input) {
      setIsRenaming(false)
      return
    }
    const newName = input.value.trim()
    // Enter unmounts the input and triggers blur; consume that trailing event to avoid a second rename.
    renameCancelledRef.current = true
    setIsRenaming(false)
    if (!newName || newName === currentFileName) {
      return
    }
    const worktreePath = getUntitledFileRoot(activeFile, worktree?.path ?? null)
    void renameFileOnDisk({
      oldPath: activeFile.filePath,
      newName,
      worktreeId: activeFile.worktreeId,
      worktreePath,
      documentScoped:
        editorTabDocumentFolderAccess(useAppStore.getState(), activeFile) !== undefined
    })
  }

  const cancelRename = (): void => {
    renameCancelledRef.current = true
    setIsRenaming(false)
  }

  const clearRenameFocusFrame = useCallback((): void => {
    if (renameFocusFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(renameFocusFrameRef.current)
    renameFocusFrameRef.current = null
  }, [])

  const renameInputRef = useCallback<RefCallback<HTMLInputElement>>(
    (el) => {
      renameInputElementRef.current = el
      clearRenameFocusFrame()
      if (!el || !isRenaming) {
        return
      }

      // Focus after header layout settles and select only the basename, preserving the extension as other rename surfaces do.
      renameFocusFrameRef.current = requestAnimationFrame(() => {
        renameFocusFrameRef.current = null
        if (renameInputElementRef.current !== el) {
          return
        }
        el.focus()
        const dotIndex = currentFileName.lastIndexOf('.')
        if (dotIndex > 0) {
          el.setSelectionRange(0, dotIndex)
        } else {
          el.select()
        }
      })
    },
    [clearRenameFocusFrame, currentFileName, isRenaming]
  )

  return {
    canRename,
    currentFileName,
    isRenaming,
    renameInputRef,
    openRenameInput,
    commitRename,
    cancelRename
  }
}
