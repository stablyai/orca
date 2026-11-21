import type { editor } from 'monaco-editor'
import { shouldIgnoreTrimWhitespace } from '../../../../../../shared/source-control/diff/diff-whitespace'

export function buildDiffEditorWhitespaceOptions(
  diffShowWhitespace: boolean | undefined
): Pick<editor.IStandaloneDiffEditorConstructionOptions, 'ignoreTrimWhitespace'> {
  return {
    // Why: Monaco defaults this to true, which hides indentation-only diffs.
    ignoreTrimWhitespace: shouldIgnoreTrimWhitespace(diffShowWhitespace)
  }
}
