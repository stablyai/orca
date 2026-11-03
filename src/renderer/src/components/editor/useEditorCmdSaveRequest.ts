import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT,
  type EditorRequestCmdSaveDetail
} from './editor-autosave'
import type { FileContent } from './editor-panel-content-types'
import { getEditorSaveTargetFile } from './editor-save-target'
import { isCodeViewTab } from './editor-save-disk-precondition'
import { isEditorWritableView } from './editor-save-writer-view'
import { needsFinalNewline } from './editor-final-newline'

type UseEditorCmdSaveRequestParams = {
  activeFile: OpenFile | null
  enabled: boolean
  openFiles: OpenFile[]
  fileContents: Record<string, FileContent>
  handleSave: (content: string) => Promise<boolean>
}

export function useEditorCmdSaveRequest({
  activeFile,
  enabled,
  openFiles,
  fileContents,
  handleSave
}: UseEditorCmdSaveRequestParams): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    const handler = (event: Event): void => {
      if (
        !activeFile ||
        (event as CustomEvent<EditorRequestCmdSaveDetail>).detail?.fileId !== activeFile.id
      ) {
        return
      }
      const saveTargetFile = getEditorSaveTargetFile(activeFile, openFiles)
      if (!saveTargetFile) {
        return
      }
      // Read-only Markdown previews still save their source record’s current draft.
      const state = useAppStore.getState()
      const draft = state.editorDrafts[saveTargetFile.id]
      const loaded = fileContents[activeFile.id]
      const cleanCodeContent =
        state.settings?.editorInsertFinalNewline === true &&
        activeFile.id === saveTargetFile.id &&
        isEditorWritableView(saveTargetFile) &&
        isCodeViewTab(state, saveTargetFile) &&
        loaded &&
        !loaded.isBinary &&
        !loaded.loadError &&
        !loaded.isStale &&
        needsFinalNewline(loaded.content)
          ? loaded.content
          : undefined
      if (
        draft === undefined &&
        !saveTargetFile.isUntitled &&
        !saveTargetFile.isDirty &&
        cleanCodeContent === undefined
      ) {
        return
      }
      const fallbackContent =
        draft ?? (activeFile.mode === 'markdown-preview' ? loaded?.content : cleanCodeContent) ?? ''
      void handleSave(fallbackContent)
    }
    window.addEventListener(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, handler)
    return () => window.removeEventListener(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, handler)
  }, [activeFile, enabled, fileContents, handleSave, openFiles])
}
