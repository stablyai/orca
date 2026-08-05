import type { editor } from 'monaco-editor'

/** Chrome + density shared by every diff surface; color lives in assets/diff-view.css. */
export function buildDiffEditorAppearanceOptions(
  fontSize: number
): Pick<
  editor.IStandaloneDiffEditorConstructionOptions,
  | 'lineHeight'
  | 'guides'
  | 'renderLineHighlight'
  | 'glyphMargin'
  | 'lineDecorationsWidth'
  | 'lineNumbersMinChars'
> {
  return {
    lineHeight: Math.round(fontSize * 1.75),
    guides: { indentation: false },
    renderLineHighlight: 'none',
    glyphMargin: false,
    lineDecorationsWidth: 26,
    // Monaco takes max(digitCount, this), so the ribbon clearance is gone at 10k+ lines.
    lineNumbersMinChars: 5
  }
}
