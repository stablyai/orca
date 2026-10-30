import { useCallback, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { DiffContent, FileContent } from './editor-panel-content-types'
import { isEditorContentUnchanged } from './editor-content-dirty-state'
import { applyEditorBufferText } from './editor-buffer-adapter'

/** Commit loaded-content refs in layout effects: stabilize handler identity without letting discarded renders advance dirty baselines. */
export function useEditorContentChangeHandler({
  fileContents,
  diffContents
}: {
  fileContents: Record<string, FileContent>
  diffContents: Record<string, DiffContent>
}): (file: OpenFile | null, content: string) => void {
  const markFileDirty = useAppStore((s) => s.markFileDirty)
  const setEditorDraft = useAppStore((s) => s.setEditorDraft)
  const clearEditorDraft = useAppStore((s) => s.clearEditorDraft)
  const fileContentsRef = useRef(fileContents)
  const diffContentsRef = useRef(diffContents)
  useLayoutEffect(() => {
    fileContentsRef.current = fileContents
    diffContentsRef.current = diffContents
  }, [diffContents, fileContents])

  return useCallback(
    (file: OpenFile | null, content: string) => {
      if (
        !file ||
        !useAppStore.getState().openFiles.some((candidate) => candidate.id === file.id)
      ) {
        return
      }
      setEditorDraft(file.id, content)
      applyEditorBufferText(useAppStore.getState(), file, content)
      const ignoreTrailingWhitespace = file.language === 'markdown'
      if (file.mode === 'edit') {
        const original = fileContentsRef.current[file.id]?.content ?? ''
        markFileDirty(
          file.id,
          !isEditorContentUnchanged(content, original, ignoreTrailingWhitespace)
        )
        // Why: back at the saved text, a kept draft could later restore stale text into the model.
        if (content === original) {
          clearEditorDraft(file.id)
        }
        return
      }
      const diffContent = diffContentsRef.current[file.id]
      const original = diffContent?.kind === 'text' ? diffContent.modifiedContent : ''
      markFileDirty(file.id, !isEditorContentUnchanged(content, original, ignoreTrailingWhitespace))
    },
    [clearEditorDraft, markFileDirty, setEditorDraft]
  )
}
