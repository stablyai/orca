import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT } from './editor-autosave'
import type { FileContent } from './editor-panel-content-types'

type UseEditorCmdSaveRequestParams = {
  activeFile: OpenFile | null
  openFiles: OpenFile[]
  fileContents: Record<string, FileContent>
  handleSave: (content: string) => Promise<void>
}

export function useEditorCmdSaveRequest({
  activeFile,
  openFiles,
  fileContents,
  handleSave
}: UseEditorCmdSaveRequestParams): void {
  useEffect(() => {
    const handler = (): void => {
      if (!activeFile) {
        return
      }
      const saveTargetFile =
        activeFile.mode === 'markdown-preview'
          ? (openFiles.find(
              (openFile) =>
                openFile.id === activeFile.markdownPreviewSourceFileId && openFile.mode === 'edit'
            ) ?? null)
          : activeFile
      if (!saveTargetFile) {
        return
      }
      // Why: a markdown preview tab is read-only but fronts the same document,
      // so Cmd/Ctrl+S should save the source editor's current draft.
      const state = useAppStore.getState()
      const draft = state.editorDrafts[saveTargetFile.id]
      if (!draft && !saveTargetFile.isUntitled && !saveTargetFile.isDirty) {
        return
      }
      const fallbackContent =
        draft ??
        (activeFile.mode === 'markdown-preview' ? fileContents[activeFile.id]?.content : '')
      void handleSave(fallbackContent ?? '')
    }
    window.addEventListener(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, handler)
    return () => window.removeEventListener(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, handler)
  }, [activeFile, fileContents, handleSave, openFiles])
}
