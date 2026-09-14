import type { EditorDraftState } from '../actions/editor-draft-state'
import type { ExplorerDirState } from '../actions/explorer-dir-state'
import type { RightSidebarState } from '../actions/right-sidebar-state'
import type { EditorFilesSlice } from './editor-files-slice'
import type { EditorGitSlice } from './editor-git-slice'

export type EditorSlice = EditorDraftState &
  ExplorerDirState &
  RightSidebarState &
  EditorFilesSlice &
  EditorGitSlice
