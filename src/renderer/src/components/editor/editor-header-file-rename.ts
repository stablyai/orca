import { useCallback, useRef, useState } from 'react'
import type { RefCallback } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { useWorktreeById } from '@/store/selectors'
import { basename } from '@/lib/path'
import { renameFileOnDisk } from '@/lib/rename-file'
import { getUntitledFileRoot } from './untitled-file-rename-path'

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
  // Escape fires setIsRenaming(false), which unmounts the input. The browser
  // still fires focusout as the focused node is removed, so onBlur can invoke
  // commitRename *after* cancel — committing the typed value against the
  // user's intent. This flag suppresses the trailing blur-commit.
  const renameCancelledRef = useRef(false)
  // Why: the header renders one unkeyed path strip for every file, so a file
  // switch mid-rename would otherwise commit the typed name against the new path.
  if (renameFilePath !== activeFile.filePath) {
    renameCancelledRef.current = true
    setRenameFilePath(activeFile.filePath)
    setIsRenaming(false)
  }
  const currentFileName = basename(activeFile.filePath)
  // Why: read-only tabs (AI Vault View Log) are never renameable — rename would
  // rewrite the agent-owned artifact's backing path.
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
    // onBlur follows Enter when the input unmounts; consume that trailing event
    // so one user action cannot start a second rename against the old path.
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
      worktreePath
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

      // Why: focus belongs to the rename input mount; the frame lets the header
      // layout settle before selecting text. Preselect the basename only, so
      // typing replaces the name and leaves the extension — same as the tab bar
      // and the file explorer.
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
