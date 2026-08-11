import { useCallback } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { attemptEditorFileSave } from './editor-file-save-attempt'
import { getEditorSaveTargetFile } from './editor-save-target'

type UseEditorPanelSaveParams = {
  activeFile: OpenFile | null
  openFiles: OpenFile[]
  requestRenameForFile: (fileId: string) => void
}

export function useEditorPanelSave({
  activeFile,
  openFiles,
  requestRenameForFile
}: UseEditorPanelSaveParams) {
  const handleSaveForFile = useCallback(
    async (file: OpenFile | null, content: string): Promise<boolean> => {
      if (!file) {
        return false
      }
      const saveTargetFile = getEditorSaveTargetFile(file, openFiles)
      if (!saveTargetFile) {
        return false
      }
      if (saveTargetFile.isUntitled) {
        requestRenameForFile(saveTargetFile.id)
        return false
      }
      return attemptEditorFileSave({ fileId: saveTargetFile.id, fallbackContent: content })
    },
    [openFiles, requestRenameForFile]
  )
  const handleSave = useCallback(
    (content: string): Promise<boolean> => handleSaveForFile(activeFile, content),
    [activeFile, handleSaveForFile]
  )
  return { handleSave, handleSaveForFile }
}
