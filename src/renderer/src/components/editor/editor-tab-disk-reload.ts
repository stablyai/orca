import { useAppStore } from '@/store'
import { isExternalReloadableEditorTab, requestEditorFileReload } from './editor-autosave'
import { reloadTabContentFromDisk } from './ExternalFileChangeBanner'

/** User-requested "Reload from Disk" (editor tab context menu). Dirty tabs go
 *  through reloadTabContentFromDisk so the discarded draft gets the same Undo
 *  toast as the conflict banner; the refetch itself is delegated to the owning
 *  EditorPanel via the reload-request event. */
export function requestEditorTabDiskReload(fileId: string): void {
  const file = useAppStore.getState().openFiles.find((openFile) => openFile.id === fileId)
  if (!file || !isExternalReloadableEditorTab(file)) {
    return
  }
  if (file.isDirty) {
    reloadTabContentFromDisk(file, (target) => requestEditorFileReload(target.id))
    return
  }
  requestEditorFileReload(file.id)
}
