import { useCallback, useState } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { requestEditorSaveQuiesce } from '@/components/editor/editor-autosave'

type UseTerminalSaveDialogParams = {
  openFiles: OpenFile[]
  closeFile: (fileId: string) => void
  markFileDirty: (fileId: string, dirty: boolean) => void
}

type UseTerminalSaveDialogResult = {
  saveDialogFileId: string | null
  saveDialogFile: OpenFile | null
  requestCloseFile: (fileId: string) => void
  handleSaveDialogSave: () => void
  handleSaveDialogDiscard: () => void
  handleSaveDialogCancel: () => void
}

export function useTerminalSaveDialog({
  openFiles,
  closeFile,
  markFileDirty
}: UseTerminalSaveDialogParams): UseTerminalSaveDialogResult {
  const [saveDialogFileId, setSaveDialogFileId] = useState<string | null>(null)

  const saveDialogFile = saveDialogFileId
    ? (openFiles.find((f) => f.id === saveDialogFileId) ?? null)
    : null

  const requestCloseFile = useCallback(
    (fileId: string) => {
      const file = openFiles.find((openFile) => openFile.id === fileId)
      if (file?.isDirty) {
        setSaveDialogFileId(fileId)
        return
      }
      closeFile(fileId)
    },
    [closeFile, openFiles]
  )

  const handleSaveDialogSave = useCallback(() => {
    if (!saveDialogFileId) {
      return
    }

    window.dispatchEvent(
      new CustomEvent('orca:save-and-close', { detail: { fileId: saveDialogFileId } })
    )
    setSaveDialogFileId(null)
  }, [saveDialogFileId])

  const handleSaveDialogDiscard = useCallback(async () => {
    if (!saveDialogFileId) {
      return
    }

    // Why: "Don't Save" must win over any pending autosave write for the same
    // tab, even if the editor is currently waiting on a background debounce.
    await requestEditorSaveQuiesce({ fileId: saveDialogFileId })
    markFileDirty(saveDialogFileId, false)
    closeFile(saveDialogFileId)
    setSaveDialogFileId(null)
  }, [closeFile, markFileDirty, saveDialogFileId])

  const handleSaveDialogCancel = useCallback(() => {
    setSaveDialogFileId(null)
  }, [])

  return {
    saveDialogFileId,
    saveDialogFile,
    requestCloseFile,
    handleSaveDialogSave,
    handleSaveDialogDiscard,
    handleSaveDialogCancel
  }
}
