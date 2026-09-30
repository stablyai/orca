import { releaseExternalEditorSaveWait } from '@/components/editor/editor-autosave'
import { useAppStore } from '../../store'
import { EXTERNAL_EDITOR_RENDERER_UNAVAILABLE } from '../../../../shared/external-editor'

/** Keep each caller attached to its edit session when a path-derived ID changes. */
export function tagExternalEditorFileWait(fileId: string, requestId: string): () => void {
  let found = false
  useAppStore.setState((state) => ({
    openFiles: state.openFiles.map((file) => {
      if (file.id !== fileId) {
        return file
      }
      found = true
      return { ...file, externalEditorWaitIds: [...(file.externalEditorWaitIds ?? []), requestId] }
    })
  }))
  if (!found) {
    throw new Error(EXTERNAL_EDITOR_RENDERER_UNAVAILABLE)
  }
  return () => {
    useAppStore.setState((state) => {
      if (!state.openFiles.some((file) => file.externalEditorWaitIds?.includes(requestId))) {
        return state
      }
      return {
        openFiles: state.openFiles.map((file) => {
          if (!file.externalEditorWaitIds?.includes(requestId)) {
            return file
          }
          const remaining = file.externalEditorWaitIds.filter((id) => id !== requestId)
          return { ...file, externalEditorWaitIds: remaining.length > 0 ? remaining : undefined }
        })
      }
    })
    releaseExternalEditorSaveWait(requestId)
  }
}
