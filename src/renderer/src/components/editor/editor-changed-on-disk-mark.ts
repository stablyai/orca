import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { canAutoSaveOpenFile } from './editor-autosave'
import { editorModelSiblingTabs } from './editor-save-disk-precondition'
import { trackExternalChangeConflictShown } from './editor-external-change-telemetry'

// Why: the changed-on-disk mark has one rule — dirty, banner-capable tab,
// telemetry only on the first surfacing — but three writers (the watch hook
// at fs-event time, the autosave controller's notification backstop, and the
// restored-tab conflict scan). Centralizing keeps the rule from drifting;
// each writer keeps its own echo/eligibility guard at the call site. A code
// model is dirty when any of its tabs is, and the mark reaches all of them.
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
  for (const tab of tabs) {
    state.setExternalMutation(tab.id, 'changed')
  }
}
