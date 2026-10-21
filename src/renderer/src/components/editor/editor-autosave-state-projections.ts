import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  editorBufferIdOfView,
  type EditorBufferViewIndex
} from '@/store/slices/editor/buffers/editor-buffer-views'

export type AutosaveSubscriberInputs = {
  openFiles: AppState['openFiles']
  editorDrafts: AppState['editorDrafts']
  editorAutoSave: boolean | undefined
  editorAutoSaveDelayMs: number | undefined
}

export function getAutosaveSubscriberInputs(state: AppState): AutosaveSubscriberInputs {
  return {
    openFiles: state.openFiles,
    editorDrafts: state.editorDrafts,
    editorAutoSave: state.settings?.editorAutoSave,
    editorAutoSaveDelayMs: state.settings?.editorAutoSaveDelayMs
  }
}

export function autosaveSubscriberInputsEqual(
  a: AutosaveSubscriberInputs,
  b: AutosaveSubscriberInputs
): boolean {
  return (
    a.openFiles === b.openFiles &&
    a.editorDrafts === b.editorDrafts &&
    a.editorAutoSave === b.editorAutoSave &&
    a.editorAutoSaveDelayMs === b.editorAutoSaveDelayMs
  )
}

/** The views a restart save writes: the first dirty view of each record. */
export function restartSaveTargets(
  state: Pick<AppState, 'openFiles'> & EditorBufferViewIndex
): OpenFile[] {
  const recordIds = new Set<string>()
  return state.openFiles.filter((file) => {
    const recordId = editorBufferIdOfView(state, file.id)
    if (!file.isDirty || recordIds.has(recordId)) {
      return false
    }
    recordIds.add(recordId)
    return true
  })
}

/** Paths held by more than one dirty record, e.g. an edit tab plus an unstaged diff. */
export function getDuplicateDirtySavePaths(files: OpenFile[]): string[] {
  const counts = new Map<string, number>()
  for (const file of files) {
    counts.set(file.filePath, (counts.get(file.filePath) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([filePath]) => filePath)
}
