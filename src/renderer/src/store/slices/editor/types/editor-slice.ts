import type { EditorViewState } from '../presentation/editor-view-state'
import type { EditorDraftState } from '../buffers/editor-draft-state'
import type { ExplorerDirState } from '../explorer/explorer-dir-state'
import type { RightSidebarState } from '../../right-sidebar/right-sidebar-state'
import type { EditorFilesSlice } from './editor-files-slice'
import type { EditorGitSlice } from './editor-git-slice'

export type EditorSlice = EditorDraftState &
  EditorViewState &
  ExplorerDirState &
  RightSidebarState &
  EditorFilesSlice &
  EditorGitSlice
