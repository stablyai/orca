import type { editor } from 'monaco-editor'
import { buildDiffEditorWhitespaceOptions } from './diff-editor-whitespace-options'
import { buildDiffEditorWordWrapOptions } from './diff-editor-word-wrap-options'
import { diffEditorScrollbarOptions } from './diff-editor-scrollbar-options'
import { monacoFindOptions } from './monaco-find-options'
import { resolveDiffRenderSideBySide } from './diff-added-file-inline-mode'

/**
 * Build the Monaco options for a single-file diff tab.
 *
 * Extracted so the option set lives next to the other `buildDiffEditor*Options`
 * helpers rather than inline in an already max-lines-capped component.
 *
 * @param input.editable Whether the modified side accepts edits.
 * @param input.sideBySide The toolbar's global Side by Side mode.
 * @param input.originalContent The original side, used to detect a created file.
 * @param input.modifiedContent The modified side.
 * @param input.fontSize Diff editor font size.
 * @param input.fontFamily Resolved editor font stack.
 * @param input.wordWrap Whether the diff wraps long lines.
 * @param input.showWhitespace Whether whitespace is rendered.
 * @returns Options for the diff editor.
 */
export function buildDiffViewerEditorOptions(input: {
  editable: boolean
  sideBySide: boolean
  originalContent: string
  modifiedContent: string
  fontSize: number
  fontFamily: string
  wordWrap: boolean | undefined
  showWhitespace: boolean | undefined
}): editor.IDiffEditorConstructionOptions {
  return {
    readOnly: !input.editable,
    originalEditable: false,
    renderSideBySide: resolveDiffRenderSideBySide(input.sideBySide, input),
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: input.fontSize,
    fontFamily: input.fontFamily,
    lineNumbers: 'on',
    ...buildDiffEditorWordWrapOptions(input.wordWrap),
    ...buildDiffEditorWhitespaceOptions(input.showWhitespace),
    automaticLayout: true,
    renderOverviewRuler: true,
    scrollbar: diffEditorScrollbarOptions,
    padding: { top: 0 },
    find: monacoFindOptions
  }
}
