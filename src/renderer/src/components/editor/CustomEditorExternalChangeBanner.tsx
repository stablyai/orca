import type { OpenFile } from '@/store/slices/editor'
import { ExternalFileChangeBanner } from './ExternalFileChangeBanner'
import { useCustomEditorMerging } from './use-custom-editor-outside-merge'

/** The external-change banner, hidden only while a custom editor is merging the change itself. */
export function CustomEditorExternalChangeBanner(props: {
  file: OpenFile
  currentContent: string
  reloadContent: (file: OpenFile) => void
}): React.JSX.Element | null {
  return useCustomEditorMerging(props.file.id) ? null : <ExternalFileChangeBanner {...props} />
}
