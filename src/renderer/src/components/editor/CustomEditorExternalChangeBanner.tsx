import type { OpenFile } from '@/store/slices/editor'
import { ExternalFileChangeBanner } from './ExternalFileChangeBanner'
import { useCustomEditorMerges } from './use-custom-editor-outside-merge'

/** The external-change banner, except for a custom editor that merges the change itself. */
export function CustomEditorExternalChangeBanner(props: {
  file: OpenFile
  currentContent: string
  reloadContent: (file: OpenFile) => void
}): React.JSX.Element | null {
  return useCustomEditorMerges(props.file.id) ? null : <ExternalFileChangeBanner {...props} />
}
