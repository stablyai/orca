import type { editor } from 'monaco-editor'
import type { DiffSectionItemProps } from './diff-section-item-props'
import { getLiveDiffSectionRenderLimit } from './diff-section-live-render-limit'
import { useEditorModelContentCheckpoint } from './use-editor-model-content-checkpoint'

export function useDiffSectionContentCheckpoint({
  modifiedEditor,
  section,
  pendingFileId,
  onDraftChange,
  setSections,
  enabled
}: Pick<DiffSectionItemProps, 'section' | 'pendingFileId' | 'onDraftChange' | 'setSections'> & {
  modifiedEditor: editor.ICodeEditor | null
  enabled: boolean
}): void {
  useEditorModelContentCheckpoint({
    editor: modifiedEditor,
    enabled,
    fileId: pendingFileId,
    ownerKey: `${section.key}:${section.contentGeneration ?? 0}`,
    publish: (content) => {
      if (!modifiedEditor) {
        return
      }
      onDraftChange?.(section, content)
      setSections((previous) => {
        let changed = false
        const next = previous.map((current) => {
          if (current.key !== section.key) {
            return current
          }
          const baseline =
            current.diffResult?.kind === 'text'
              ? current.diffResult.modifiedContent
              : current.modifiedContent
          const dirty = content !== baseline
          if (current.modifiedContent === content && current.dirty === dirty) {
            return current
          }
          changed = true
          // Why: virtualized rows must publish their latest text before the model is released.
          return {
            ...current,
            modifiedContent: content,
            dirty,
            largeDiffRenderLimit: getLiveDiffSectionRenderLimit({
              section: current,
              modifiedEditor,
              modifiedContent: content
            })
          }
        })
        return changed ? next : previous
      })
    }
  })
}
