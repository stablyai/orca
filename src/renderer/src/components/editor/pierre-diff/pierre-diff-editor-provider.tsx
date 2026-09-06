import { useCallback } from 'react'
import { EditProvider } from '@pierre/diffs/react'
import type { EditorFactory } from '@pierre/diffs/react'
import { Editor } from '@pierre/diffs/edit'
import type { PierreDiffAnnotationData } from './pierre-diff-comment-annotations'

/**
 * Supplies the editor factory every editable diff surface pulls from. Pierre
 * creates one editor per active session, so this stays a plain constructor —
 * per-section behavior belongs in each component's `editorOptions`.
 */
export function PierreDiffEditProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const createEditor = useCallback<EditorFactory<PierreDiffAnnotationData, undefined>>(
    (editorType, options, editStateKey) => new Editor(editorType, options, editStateKey),
    []
  )

  return (
    <EditProvider<PierreDiffAnnotationData, undefined> createEditor={createEditor}>
      {children}
    </EditProvider>
  )
}
