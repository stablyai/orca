export type {
  ActiveRightSidebarTab,
  RightSidebarExplorerView,
  RightSidebarTab
} from '../../../../shared/ui-chrome-types'

export type {
  ActivityBarPosition,
  ClosedEditorTabSnapshot,
  EditorViewMode,
  MarkdownViewMode,
  OpenFile
} from './editor/types/open-file'

export type {
  BranchCompareSnapshot,
  CombinedDiffSkippedConflict,
  CommitCompareSnapshot,
  ConflictReviewEntry,
  ConflictReviewState,
  DiffSource,
  OpenConflictMetadata
} from '../../../../shared/editor-tab-view-types'

export type { EditorSlice } from './editor/types/editor-slice'

export type {
  PendingEditorFocusRequest,
  PendingEditorReveal
} from './editor/types/pending-editor-reveal'

export type { OpenFilePathRekey, RekeyOpenFilesResult } from './editor/types/open-file-path-rekey'

export type {
  RestoredEditorOwnerMigration,
  RestoredEditorOwnerResult
} from './editor/types/restored-editor-owner'

export {
  buildDiffEditorFileId,
  buildOwnedEditorFileId,
  resolveEditorFileIdForOwner
} from './editor/file-ids/editor-file-ids'

export { createEditorSlice } from './editor/create-editor-slice'
