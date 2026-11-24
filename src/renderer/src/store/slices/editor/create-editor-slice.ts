import { createEditorViewState } from './presentation/editor-view-state'
import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { EditorSlice } from './types/editor-slice'
import { createEditorDraftState } from './buffers/editor-draft-state'
import { createRightSidebarState } from '../right-sidebar/right-sidebar-state'
import { createExplorerDirState } from './explorer/explorer-dir-state'
import { createOpenFileState } from './opening/open-file-state'
import { createOpenFileAction } from './opening/open-file-action'
import { createMarkdownPreviewActions } from './markdown/markdown-preview-actions'
import { createPluginNewFileActions } from './opening/untitled-file-creation'
import { createCloseFileAction } from './closing/close-file-action'
import { createRecentlyClosedEditorTabs } from './closing/recently-closed-editor-tabs'
import { createOpenFileMutations } from './opening/open-file-mutations'
import { createRestoredEditorOwner } from './hydration/restored-editor-owner'
import { createRekeyOpenFilesAction } from './file-ids/rekey-open-files-action'
import { createOpenUnstagedDiff } from './git/open-unstaged-diff'
import { createOpenHistoryDiff } from './git/open-history-diff'
import { createOpenCombinedDiff } from './git/open-combined-diff'
import { createOpenConflictFile } from './git/open-conflict-file'
import { createOpenConflictReview } from './git/open-conflict-review'
import { createCheckRunDetailsActions } from './checks/check-run-details-actions'
import { createEditorCursorLine } from './focus/editor-cursor-line'
import { createGitStatusActions } from './git/git-status-actions'
import { createGitRemoteStatus } from './git/git-remote-status'
import { createGitRemotePushPull } from './git/git-remote-push-pull'
import { createGitRemoteSync } from './git/git-remote-sync'
import { createGitBranchCompareActions } from './git/git-branch-compare-actions'
import { createFileSearchActions } from './search/file-search-actions'
import { createEditorRevealFocusState } from './focus/editor-reveal-focus-state'
import { createMarkdownLinkAction } from './markdown/markdown-link-action'
import { createHydrateEditorSession } from './hydration/hydrate-editor-session'
import { createEditorBufferIdentityActions } from './buffers/editor-buffer-identity-actions'

export const createEditorSlice: StateCreator<AppState, [], [], EditorSlice> = (set, get) => ({
  ...createEditorDraftState(set),
  ...createEditorViewState(set, get),
  ...createRightSidebarState(set, get),
  ...createExplorerDirState(set, get),
  ...createOpenFileState(set, get),
  ...createOpenFileAction(set, get),
  ...createMarkdownPreviewActions(set, get),
  ...createPluginNewFileActions(set, get),
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
  ...createHydrateEditorSession(set, get),
  ...createEditorBufferIdentityActions(set, get)
})
