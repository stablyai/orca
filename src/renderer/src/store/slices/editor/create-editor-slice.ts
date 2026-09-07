import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { EditorSlice } from './types/editor-slice'
import { createEditorDraftState } from './actions/editor-draft-state'
import { createRightSidebarState } from './actions/right-sidebar-state'
import { createExplorerDirState } from './actions/explorer-dir-state'
import { createOpenFileState } from './actions/open-file-state'
import { createOpenFileAction } from './actions/open-file-action'
import { createMarkdownPreviewActions } from './actions/markdown-preview-actions'
import { createCloseFileAction } from './actions/close-file-action'
import { createRecentlyClosedEditorTabs } from './actions/recently-closed-editor-tabs'
import { createOpenFileMutations } from './actions/open-file-mutations'
import { createRestoredEditorOwner } from './actions/restored-editor-owner'
import { createRekeyOpenFilesAction } from './actions/rekey-open-files-action'
import { createOpenUnstagedDiff } from './actions/open-unstaged-diff'
import { createOpenHistoryDiff } from './actions/open-history-diff'
import { createOpenCombinedDiff } from './actions/open-combined-diff'
import { createOpenConflictFile } from './actions/open-conflict-file'
import { createOpenConflictReview } from './actions/open-conflict-review'
import { createCheckRunDetailsActions } from './actions/check-run-details-actions'
import { createEditorCursorLine } from './actions/editor-cursor-line'
import { createGitStatusActions } from './actions/git-status-actions'
import { createGitRemoteStatus } from './actions/git-remote-status'
import { createGitRemotePushPull } from './actions/git-remote-push-pull'
import { createGitRemoteSync } from './actions/git-remote-sync'
import { createGitBranchCompareActions } from './actions/git-branch-compare-actions'
import { createFileSearchActions } from './actions/file-search-actions'
import { createEditorRevealFocusState } from './actions/editor-reveal-focus-state'
import { createMarkdownLinkAction } from './actions/markdown-link-action'
import { createHydrateEditorSession } from './actions/hydrate-editor-session'

export const createEditorSlice: StateCreator<AppState, [], [], EditorSlice> = (set, get) => ({
  ...createEditorDraftState(set, get),
  ...createRightSidebarState(set, get),
  ...createExplorerDirState(set, get),
  ...createOpenFileState(set, get),
  ...createOpenFileAction(set, get),
  ...createMarkdownPreviewActions(set, get),
  ...createCloseFileAction(set, get),
  ...createRecentlyClosedEditorTabs(set, get),
  ...createOpenFileMutations(set, get),
  ...createRestoredEditorOwner(set, get),
  ...createRekeyOpenFilesAction(set, get),
  ...createOpenUnstagedDiff(set, get),
  ...createOpenHistoryDiff(set, get),
  ...createOpenCombinedDiff(set, get),
  ...createOpenConflictFile(set, get),
  ...createOpenConflictReview(set, get),
  ...createCheckRunDetailsActions(set, get),
  ...createEditorCursorLine(set, get),
  ...createGitStatusActions(set, get),
  ...createGitRemoteStatus(set, get),
  ...createGitRemotePushPull(set, get),
  ...createGitRemoteSync(set, get),
  ...createGitBranchCompareActions(set, get),
  ...createFileSearchActions(set, get),
  ...createEditorRevealFocusState(set, get),
  ...createMarkdownLinkAction(set, get),
  ...createHydrateEditorSession(set, get)
})
