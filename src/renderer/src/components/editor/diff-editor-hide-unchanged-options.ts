import type { editor } from 'monaco-editor'

/** Collapse unchanged regions in combined diffs; single-file callers opt in so full-file review remains their default. */
export function buildDiffEditorHideUnchangedOptions(
  collapseUnchangedRegions: boolean | undefined
): Pick<editor.IStandaloneDiffEditorConstructionOptions, 'hideUnchangedRegions'> {
  return {
    hideUnchangedRegions: { enabled: collapseUnchangedRegions === true }
  }
}
