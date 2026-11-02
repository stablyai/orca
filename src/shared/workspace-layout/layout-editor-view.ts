// Keep transient diff/conflict/preview/check-details file facts in memory so windows can rebuild tabs with no saved file record.

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
