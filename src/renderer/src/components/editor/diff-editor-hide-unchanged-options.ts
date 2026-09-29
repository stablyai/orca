import type { editor } from 'monaco-editor'

/**
 * Collapses runs of unchanged lines in a diff into expandable bands, leaving a few
 * lines of context around each change. The combined diff view enables this
 * unconditionally; single-file diffs gate it behind a setting so full-file review
 * stays the default.
 */
export function buildDiffEditorHideUnchangedOptions(
  collapseUnchangedRegions: boolean | undefined
): Pick<editor.IStandaloneDiffEditorConstructionOptions, 'hideUnchangedRegions'> {
  return {
    hideUnchangedRegions: { enabled: collapseUnchangedRegions === true }
  }
}
