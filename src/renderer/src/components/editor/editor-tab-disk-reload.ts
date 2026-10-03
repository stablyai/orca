import { useAppStore } from '@/store'
import { isExternalReloadableEditorTab, requestEditorFileReload } from './editor-autosave'
import { reloadTabContentFromDisk } from './ExternalFileChangeBanner'

/** User-requested "Reload from Disk" (editor tab context menu). Always routes
 *  through reloadTabContentFromDisk — isDirty lags editorDrafts (debounced), so
 *  gating on it could leave a not-yet-dirty draft shadowing the reloaded
 *  content. For clean tabs its mutations are no-ops and the Undo toast fires
 *  only when a draft was actually discarded; the refetch itself is delegated
 *  to the owning EditorPanel via the reload-request event. */
export function requestEditorTabDiskReload(fileId: string): void {
  const file = useAppStore.getState().openFiles.find((openFile) => openFile.id === fileId)
  if (!file || !isExternalReloadableEditorTab(file)) {
    return
  }
  reloadTabContentFromDisk(file, (target) => requestEditorFileReload(target.id))
}
