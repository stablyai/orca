import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'

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

export function getDuplicateDirtySavePaths(files: OpenFile[]): string[] {
  const counts = new Map<string, number>()
  for (const file of files) {
    counts.set(file.filePath, (counts.get(file.filePath) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([filePath]) => filePath)
}
