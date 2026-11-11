import type { editor } from 'monaco-editor'
import { diffNativeScrollOffsets } from './combined-diff-layout'
import { DIFF_SECTION_PADDING_HEIGHT } from '../../diff/sections/diff-section-layout'

export function isCombinedDiffScrollApplied(
  diff: editor.IStandaloneDiffEditor,
  model: editor.IDiffEditorModel,
  requested: number
): boolean {
  const current = diff.getModel()
  if (current?.original !== model.original || current.modified !== model.modified) {
    return false
  }
  const original = diff.getOriginalEditor()
  const modified = diff.getModifiedEditor()
  const expected = diffNativeScrollOffsets({
    requested,
    originalMax: Math.max(0, original.getScrollHeight() - original.getLayoutInfo().height),
    modifiedMax: Math.max(0, modified.getScrollHeight() - modified.getLayoutInfo().height),
    originalToModified: diff.getScrollTopOffset()
  })
  return (
    Math.abs(original.getScrollTop() - expected.original) < 1 &&
    Math.abs(modified.getScrollTop() - expected.modified) < 1
  )
}

export function readCombinedDiffHeight(
  diff: editor.IStandaloneDiffEditor,
  viewModel: editor.IIndependentDiffEditorViewModel,
  width: number,
  chromeHeight: number
): number | null {
  const state = viewModel.getDiffState()
  if (!state.isDiffUpToDate || !state.hasResult || width <= 0) {
    return null
  }
  return (
    chromeHeight +
    DIFF_SECTION_PADDING_HEIGHT +
    Math.max(
      diff.getOriginalEditor().getContentHeight(),
      diff.getModifiedEditor().getContentHeight()
    )
  )
}
