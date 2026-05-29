import { useEffect, useRef, useState } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { useWorktreeById } from '@/store/selectors'
import { basename } from '@/lib/path'
import { renameFileOnDisk } from '@/lib/rename-file'
import { getUntitledFileRoot } from './untitled-file-rename-path'

type EditorHeaderFileRenameState = {
  canRename: boolean
  currentFileName: string
  isRenaming: boolean
  renameInputRef: React.RefObject<HTMLInputElement | null>
  openRenameInput: () => void
  commitRename: () => void
  cancelRename: () => void
}

export function useEditorHeaderFileRename(activeFile: OpenFile): EditorHeaderFileRenameState {
  const worktree = useWorktreeById(activeFile.worktreeId)
  const [isRenaming, setIsRenaming] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameCancelledRef = useRef(false)
  const currentFileName = basename(activeFile.filePath)
  const canRename =
    activeFile.mode === 'edit' && !activeFile.diffSource && !activeFile.conflict && !isRenaming

  const openRenameInput = (): void => {
    if (!canRename) {
      return
    }
    renameCancelledRef.current = false
    setIsRenaming(true)
  }

  const commitRename = (): void => {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false
      setIsRenaming(false)
      return
    }
    const input = renameInputRef.current
    if (!input) {
      setIsRenaming(false)
      return
    }
    const newName = input.value.trim()
    setIsRenaming(false)
    if (!newName || newName === currentFileName) {
      return
    }
    const worktreePath = getUntitledFileRoot(activeFile, worktree?.path ?? null)
    void renameFileOnDisk({
      oldPath: activeFile.filePath,
      newName,
      worktreeId: activeFile.worktreeId,
      worktreePath
    })
  }

  const cancelRename = (): void => {
    renameCancelledRef.current = true
    setIsRenaming(false)
  }

  useEffect(() => {
    if (!isRenaming) {
      return
    }
    const raf = requestAnimationFrame(() => {
      const el = renameInputRef.current
      if (!el) {
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
    return () => cancelAnimationFrame(raf)
  }, [currentFileName, isRenaming])

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
