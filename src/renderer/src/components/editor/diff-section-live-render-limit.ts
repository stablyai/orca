import type { editor as monacoEditor } from 'monaco-editor'
import type { DiffSection } from './diff-section-types'
import {
  getLargeDiffRenderLimitFromCounts,
  type LargeDiffRenderLimit
} from './large-diff-render-limit'

export function getLiveDiffSectionRenderLimit({
  section,
  modifiedEditor,
  modifiedContent
}: {
  section: DiffSection
  modifiedEditor: monacoEditor.ICodeEditor
  modifiedContent: string
}): LargeDiffRenderLimit {
  const modifiedLineCount =
    modifiedContent.length === 0
      ? 0
      : (modifiedEditor.getModel()?.getLineCount() ??
        section.largeDiffRenderLimit?.lineCounts?.modified ??
        0)

  return getLargeDiffRenderLimitFromCounts({
    originalLineCount: section.largeDiffRenderLimit?.lineCounts?.original ?? 0,
    modifiedLineCount,
    originalCharacterCount: section.originalContent.length,
    modifiedCharacterCount: modifiedContent.length
  })
}
