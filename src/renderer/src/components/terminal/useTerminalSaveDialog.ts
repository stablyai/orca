import { useCallback, useState } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { ORCA_EDITOR_SAVE_AND_CLOSE_EVENT } from '@/components/editor/editor-autosave'
import { discardEditorFileChangesAndClose } from '@/components/editor/discard-editor-file-changes'

type UseTerminalSaveDialogParams = {
  openFiles: OpenFile[]
  closeFile: (fileId: string) => void
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
  closeFile
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
      new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId: saveDialogFileId } })
    )
    setSaveDialogFileId(null)
  }, [saveDialogFileId])

  const handleSaveDialogDiscard = useCallback(async () => {
    if (!saveDialogFileId) {
      return
    }

    await discardEditorFileChangesAndClose(saveDialogFileId)
    setSaveDialogFileId(null)
  }, [saveDialogFileId])

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
