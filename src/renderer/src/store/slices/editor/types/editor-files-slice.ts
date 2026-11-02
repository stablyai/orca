import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import type { CheckRunDetailsTabPatch } from '@/components/editor/check-run-details-tab'
import type {
  CombinedDiffAlternate,
  ConflictReviewEntry,
  ConflictReviewState,
  OpenCheckRunDetailsState
} from '../../../../../../shared/editor-tab-view-types'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary,
  GitCommitCompareSummary
} from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { WorkspaceVisibleTabType } from '../../../../../../shared/tab-types'
import type {
  BranchCompareLike,
  ClosedEditorTabSnapshot,
  CommitCompareLike,
  EditorOpenTargetOptions,
  EditorTabSelection,
  OpenFile
} from './open-file'
import type { EditorBufferRecords } from '../buffers/editor-buffer-record'
import type {
  EditorBufferKeepRequest,
  EditorBufferKeptRecords
} from '../buffers/editor-buffer-kept'
import type { EditorBufferDetachments, EditorBufferViewIndex } from '../buffers/editor-buffer-views'
import type { EditorOpenLinkIntent, EditorOpenResult } from './editor-open-link-intent'
import type { OpenFilePathRekey, RekeyOpenFilesResult } from './open-file-path-rekey'
import type {
  RestoredEditorOwnerMigration,
  RestoredEditorOwnerResult
} from './restored-editor-owner'

export type OpenFileOptions = {
  preview?: boolean
  targetGroupId?: string
  recordReplacedPreview?: boolean
  suppressActiveRuntimeFallback?: boolean
  forceContentReload?: boolean
  focusEditor?: boolean
  reopenId?: string
  selection?: EditorTabSelection
  /** Where in its group a reopened tab goes back to, when the open makes a new tab. */
  groupIndex?: number
}

export type EditorFilesSlice = {
  openFiles: OpenFile[]
  /** Buffer state per record (file identity, or tab id for views that never share); views mirror it. */
  editorBuffers: EditorBufferRecords
  /** View id → record id; maintained with `openFiles` by the record middleware. */
  editorBufferIdOf: EditorBufferViewIndex['editorBufferIdOf']
  /** Record id → view ids; maintained with `openFiles` by the record middleware. */
  editorBufferViews: EditorBufferViewIndex['editorBufferViews']
  /** Views kept off the record their identity names (divergent dirty drafts, retired hosts). */
  editorBufferDetached: EditorBufferDetachments
  /** Dirty records whose last view closed without a prompt, by record id; reopening joins them. */
  editorBufferKept: EditorBufferKeptRecords
  /** Write-only: a closing write asks to keep its views' dirty records; never stored. */
  editorBufferKeepRequest?: EditorBufferKeepRequest
  /** Drops the kept records a removal notice left behind (the notice went away). */
  releaseKeptEditorBuffers: (notice: number) => void
  /** A write landed `content` for kept records of `viewIds`: drop one it saved, else move its baseline. */
  settleKeptEditorBuffers: (viewIds: readonly string[], content: string, signature: string) => void
  /** Bumped when runtime revisions change, so the record middleware re-resolves identities. */
  editorBufferIdentityRevision: number
  /** Re-resolves every view's file identity after a change the store can't see (revisions). */
  reconcileEditorBufferIdentities: () => void
  /** Keeps views on retired environments off every other record, with their drafts. */
  detachRetiredEditorBuffers: (environmentIds: readonly string[]) => void
  activeFileId: string | null
  activeFileIdByWorktree: Record<string, string | null>
  activeTabTypeByWorktree: Record<string, WorkspaceVisibleTabType>
  activeTabType: WorkspaceVisibleTabType
  setActiveTabType: (type: WorkspaceVisibleTabType, worktreeId: string | null) => void
  openFile: (file: Omit<OpenFile, 'id' | 'isDirty'>, options?: OpenFileOptions) => string
  /** Open captured link intent; null on refusal. onShown receives actual view after drawing, which requires main frame in layout-owner builds. */
  openFileForLink: (
    file: Omit<OpenFile, 'id' | 'isDirty'>,
    options: Omit<OpenFileOptions, 'targetGroupId' | 'focusEditor' | 'selection'> | undefined,
    intent: EditorOpenLinkIntent | null,
    onShown?: (result: EditorOpenResult | null) => void
  ) => EditorOpenResult | null
  openNewMarkdownInActiveWorkspace: (groupId: string) => Promise<void>
  acquireEditorFileOperationProvenance: (
    file: OpenFile,
    selected?: OpenFile['operationProvenance']
  ) => OpenFile & {
    operationProvenance: NonNullable<OpenFile['operationProvenance']>
  }
  /** Creates a plugin's new-file type at the active workspace root and opens it. */
  openNewPluginFileInActiveWorkspace: (
    newFile: { pluginKey: string; id: string; title: string; extension: string },
    groupId?: string
  ) => Promise<void>
  /** Opens an empty `untitled<extension>` at the active workspace root. */
  openBlankFileInActiveWorkspace: (extension: string) => Promise<void>
  // Why: sequences openFile/setMarkdownViewMode/reveal around an async Monaco remount. See docs/markdown-internal-link-opening-design.md.
  activateMarkdownLink: (
    rawHref: string | undefined,
    ctx: {
      sourceFilePath: string
      worktreeId: string
      worktreeRoot: string | null
      runtimeEnvironmentId?: string | null
      sourceOwner?: HttpLinkSourceOwner
    }
  ) => Promise<void>
  openMarkdownPreview: (
    file: Pick<
      OpenFile,
      | 'filePath'
      | 'relativePath'
      | 'worktreeId'
      | 'language'
      | 'runtimeEnvironmentId'
      | 'externalSshTargetId'
    > &
      Partial<Pick<OpenFile, 'terminalArtifactGrantId' | 'readOnly' | 'operationProvenance'>>,
    options?: { anchor?: string | null; targetGroupId?: string; sourceFileId?: string }
  ) => void
  makePreviewFilePermanent: (fileId: string, tabId?: string) => void
  pinFile: (fileId: string, tabId?: string) => void
  /**
   * captureRecentlyClosed false keeps a cleanup close out of the reopen stack; keepEditorBuffer
   * keeps a no-prompt removal's dirty record past the close.
   */
  closeFile: (
    fileId: string,
    opts?: { captureRecentlyClosed?: boolean; keepEditorBuffer?: EditorBufferKeepRequest }
  ) => void
  closeAllFiles: () => void
  /** Most recently closed editor tabs per worktree (for Cmd/Ctrl+Shift+T). */
  recentlyClosedEditorTabsByWorktree: Record<string, ClosedEditorTabSnapshot[]>
  reopenClosedEditorTab: (worktreeId: string) => boolean
  /** Activation uses the file's workspace unless a target is supplied; global selection
   *  moves only when that workspace is active. */
  setActiveFile: (fileId: string, targetWorktreeId?: string) => void
  /** `written`: a save made disk match, so even a read-only view may mark its record clean. */
  markFileDirty: (fileId: string, dirty: boolean, opts?: { written?: boolean }) => void
  setExternalMutation: (fileId: string, mutation: 'deleted' | 'renamed' | 'changed' | null) => void
  /** `undefined` un-records a baseline a failed operation stamped provisionally. */
  setLastKnownDiskSignature: (fileId: string, signature: string | undefined) => void
  /** Host grant for a file outside every workspace; grants lapse, so reads and saves renew them. */
  setTerminalArtifactGrant: (fileId: string, grantId: string) => void
  clearSelfMoveEcho: (fileId: string) => void
  /** Atomically migrate path/ID-keyed editor state without close/reopen; stale/colliding moves leave state unchanged. */
  rekeyOpenFilesForPathChange: (args: {
    rekeys: readonly OpenFilePathRekey[]
    /** When set, dirty autosave-capable destinations get move-echo provenance + a synchronous autosave gate so the watcher can content-verify the echo. */
    moveOperationId?: string
  }) => RekeyOpenFilesResult
  setRestoredEditorOwnerMigrationPending: (fileId: string, pending: boolean) => boolean
  reparentRestoredEditorFileOwner: (args: RestoredEditorOwnerMigration) => RestoredEditorOwnerResult
  clearUntitled: (fileId: string) => void
  openDiff: (
    worktreeId: string,
    filePath: string,
    relativePath: string,
    language: string,
    staged: boolean,
    options?: EditorOpenTargetOptions & { selection?: EditorTabSelection; oldPath?: string }
  ) => void
  openBranchDiff: (
    worktreeId: string,
    worktreePath: string,
    entry: GitBranchChangeEntry,
    compare: BranchCompareLike,
    language: string,
    options?: EditorOpenTargetOptions
  ) => void
  openCommitDiff: (
    worktreeId: string,
    worktreePath: string,
    entry: GitBranchChangeEntry,
    compare: CommitCompareLike,
    language: string,
    options?: EditorOpenTargetOptions
  ) => void
  openAllDiffs: (
    worktreeId: string,
    worktreePath: string,
    alternate?: CombinedDiffAlternate,
    areaFilter?: string,
    entriesSnapshot?: GitStatusEntry[]
  ) => void
  openConflictFile: (
    worktreeId: string,
    worktreePath: string,
    entry: GitStatusEntry,
    language: string,
    options?: EditorOpenTargetOptions
  ) => void
  openConflictReviewFile: (
    reviewFileId: string,
    worktreeId: string,
    worktreePath: string,
    entry: GitStatusEntry,
    language: string
  ) => void
  openConflictReview: (
    worktreeId: string,
    worktreePath: string,
    entries: ConflictReviewEntry[],
    source: ConflictReviewState['source']
  ) => void
  openCheckRunDetails: (
    worktreeId: string,
    contextKey: string,
    check: OpenCheckRunDetailsState['check'],
    state: CheckRunDetailsTabPatch
  ) => void
  patchOpenCheckRunDetails: (
    worktreeId: string,
    contextKey: string,
    check: OpenCheckRunDetailsState['check'],
    state: CheckRunDetailsTabPatch
  ) => void
  reloadOpenCheckRunDetailsTab: (fileId: string) => Promise<void>
  openBranchAllDiffs: (
    worktreeId: string,
    worktreePath: string,
    compare: GitBranchCompareSummary,
    alternate?: CombinedDiffAlternate
  ) => void
  openCommitAllDiffs: (
    worktreeId: string,
    worktreePath: string,
    compare: GitCommitCompareSummary,
    entries: GitBranchChangeEntry[],
    subject?: string,
    message?: string
  ) => void
}
