import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import type {
  CheckRunDetailsTabPatch,
  OpenCheckRunDetailsState
} from '@/components/editor/check-run-details-tab'
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
  CombinedDiffAlternate,
  CommitCompareLike,
  ConflictReviewEntry,
  ConflictReviewState,
  EditorOpenTargetOptions,
  OpenFile
} from './open-file'
import type { OpenFilePathRekey, RekeyOpenFilesResult } from './open-file-path-rekey'
import type {
  RestoredEditorOwnerMigration,
  RestoredEditorOwnerResult
} from './restored-editor-owner'

export type EditorFilesSlice = {
  // Open files / editor tabs
  openFiles: OpenFile[]
  activeFileId: string | null
  activeFileIdByWorktree: Record<string, string | null> // worktreeId -> last active file
  activeTabTypeByWorktree: Record<string, WorkspaceVisibleTabType> // worktreeId -> last active tab type
  activeTabType: WorkspaceVisibleTabType
  setActiveTabType: (type: WorkspaceVisibleTabType) => void
  openFile: (
    file: Omit<OpenFile, 'id' | 'isDirty'>,
    options?: {
      preview?: boolean
      targetGroupId?: string
      recordReplacedPreview?: boolean
      suppressActiveRuntimeFallback?: boolean
      forceContentReload?: boolean
      focusEditor?: boolean
      reopenId?: string
    }
  ) => string
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
    >,
    options?: { anchor?: string | null; targetGroupId?: string; sourceFileId?: string }
  ) => void
  makePreviewFilePermanent: (fileId: string, tabId?: string) => void
  pinFile: (fileId: string, tabId?: string) => void
  closeFile: (fileId: string) => void
  closeAllFiles: () => void
  /** Most recently closed editor tabs per worktree (for Cmd/Ctrl+Shift+T). */
  recentlyClosedEditorTabsByWorktree: Record<string, ClosedEditorTabSnapshot[]>
  reopenClosedEditorTab: (worktreeId: string) => boolean
  setActiveFile: (fileId: string) => void
  reorderFiles: (fileIds: string[]) => void
  markFileDirty: (fileId: string, dirty: boolean) => void
  setExternalMutation: (fileId: string, mutation: 'deleted' | 'renamed' | 'changed' | null) => void
  setLastKnownDiskSignature: (fileId: string, signature: string) => void
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
    options?: EditorOpenTargetOptions
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
