import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { canAutoSaveOpenFile } from './editor-autosave'
import { editorModelSiblingTabs } from './editor-save-disk-precondition'
import { trackExternalChangeConflictShown } from './editor-external-change-telemetry'

// Share dirty-record/banner/first-surfacing rules across watcher, notification and restore paths; callers retain their echo/eligibility guards.
export function markFileChangedOnDisk(
  state: AppState,
  file: OpenFile,
  options: { connectionId: string | undefined; origin: 'live' | 'restore' }
): void {
  const tabs = state.openFiles.some((tab) => tab.id === file.id)
    ? editorModelSiblingTabs(state, file)
    : [file]
  if (!tabs.some((tab) => tab.isDirty) || !canAutoSaveOpenFile(file)) {
    return
  }
  if (file.externalMutation !== 'changed') {
    trackExternalChangeConflictShown(file, options)
  }
  state.setExternalMutation(file.id, 'changed')
}
