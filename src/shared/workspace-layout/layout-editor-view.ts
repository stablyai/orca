// What a non-plain editor tab shows, with the file facts a window needs to rebuild the tab's open
// file: a diff, conflict, preview or check-details tab has no saved file record. In memory only.

import type { EditorTabView } from '../editor-tab-view-types'
import type { LayoutEditorFile } from './workspace-layout-model'

export type LayoutEditorView = {
  view: EditorTabView
  file: Pick<
    LayoutEditorFile,
    | 'filePath'
    | 'relativePath'
    | 'language'
    | 'runtimeEnvironmentId'
    | 'externalSshTargetId'
    | 'readOnly'
  >
}
