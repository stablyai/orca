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
}

export type EditorFilesSlice = {
  // Open files / editor tabs
  openFiles: OpenFile[]
  /** Buffer state per open tab id; the matching OpenFile fields mirror it. */
  editorBuffers: EditorBufferRecords
  activeFileId: string | null
  activeFileIdByWorktree: Record<string, string | null> // worktreeId -> last active file
  activeTabTypeByWorktree: Record<string, WorkspaceVisibleTabType> // worktreeId -> last active tab type
  activeTabType: WorkspaceVisibleTabType
  setActiveTabType: (type: WorkspaceVisibleTabType, worktreeId: string | null) => void
  openFile: (file: Omit<OpenFile, 'id' | 'isDirty'>, options?: OpenFileOptions) => string
  /** openFile for a captured link activation; returns the actual view, or null when refused. */
  openFileForLink: (
    file: Omit<OpenFile, 'id' | 'isDirty'>,
    options: Omit<OpenFileOptions, 'targetGroupId' | 'focusEditor' | 'selection'> | undefined,
    intent: EditorOpenLinkIntent | null
  ) => EditorOpenResult | null
  openNewMarkdownInActiveWorkspace: (groupId: string) => Promise<void>
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
      Partial<Pick<OpenFile, 'terminalArtifactGrantId' | 'readOnly'>>,
    options?: { anchor?: string | null; targetGroupId?: string; sourceFileId?: string }
  ) => void
  makePreviewFilePermanent: (fileId: string, tabId?: string) => void
  pinFile: (fileId: string, tabId?: string) => void
  /** captureRecentlyClosed false keeps a cleanup close out of the reopen stack. */
  closeFile: (fileId: string, opts?: { captureRecentlyClosed?: boolean }) => void
  closeAllFiles: () => void
  /** Most recently closed editor tabs per worktree (for Cmd/Ctrl+Shift+T). */
  recentlyClosedEditorTabsByWorktree: Record<string, ClosedEditorTabSnapshot[]>
  reopenClosedEditorTab: (worktreeId: string) => boolean
  /** Activation uses the file's workspace unless a target is supplied; global selection
   *  moves only when that workspace is active. */
  setActiveFile: (fileId: string, targetWorktreeId?: string) => void
  markFileDirty: (fileId: string, dirty: boolean) => void
  setExternalMutation: (fileId: string, mutation: 'deleted' | 'renamed' | 'changed' | null) => void
  /** `undefined` un-records a baseline a failed operation stamped provisionally. */
  setLastKnownDiskSignature: (fileId: string, signature: string | undefined) => void
  clearPendingDiskBaselineVerification: (fileId: string) => void
  setPendingDiskBaselineVerification: (fileId: string, value: boolean) => void
  setPendingLiveDiskVerification: (fileId: string, value: boolean) => void
  clearSelfMoveEcho: (fileId: string) => void
  /** Atomically retargets open editor sessions across an Orca-owned move — one commit-only update migrating every path-derived id + all id-keyed state, no close/reopen. Returns collision/stale without mutating. */
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
    options?: EditorOpenTargetOptions & { selection?: EditorTabSelection }
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
