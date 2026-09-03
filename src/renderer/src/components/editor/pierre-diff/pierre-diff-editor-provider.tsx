import { useCallback } from 'react'
import { EditProvider } from '@pierre/diffs/react'
import type { CreateEditor } from '@pierre/diffs/react'
import type { DiffsEditor } from '@pierre/diffs'
import { Editor, type EditorOptions } from '@pierre/diffs/edit'

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
  const createEditor = useCallback<CreateEditor<undefined>>(
    (options: EditorOptions<undefined>): DiffsEditor<undefined> => new Editor(options),
    []
  )

  return <EditProvider createEditor={createEditor}>{children}</EditProvider>
}
