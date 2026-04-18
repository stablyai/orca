import type { StateCreator } from 'zustand';
import type { AppState } from '../types';
import type { GitBranchChangeEntry, GitBranchCompareSummary, GitConflictKind, GitConflictOperation, GitConflictResolutionStatus, GitConflictStatusSource, GitStatusEntry, GitStatusResult, SearchResult, WorkspaceSessionState, WorkspaceVisibleTabType } from '../../../../shared/types';
export type DiffSource = 'unstaged' | 'staged' | 'branch' | 'combined-uncommitted' | 'combined-branch';
export type BranchCompareSnapshot = Pick<GitBranchCompareSummary, 'baseRef' | 'baseOid' | 'compareRef' | 'headOid' | 'mergeBase'> & {
    compareVersion: string;
};
type CombinedDiffAlternate = {
    source: 'combined-uncommitted' | 'combined-branch';
    branchCompare?: BranchCompareSnapshot;
};
export type OpenConflictMetadata = {
    kind: 'conflict-editable' | 'conflict-placeholder';
    conflictKind: GitConflictKind;
    conflictStatus: GitConflictResolutionStatus;
    conflictStatusSource: GitConflictStatusSource;
    message?: string;
    guidance?: string;
};
export type ConflictReviewEntry = {
    path: string;
    conflictKind: GitConflictKind;
};
export type ConflictReviewState = {
    source: 'live-summary' | 'combined-diff-exclusion';
    snapshotTimestamp: number;
    entries: ConflictReviewEntry[];
};
export type CombinedDiffSkippedConflict = {
    path: string;
    conflictKind: GitConflictKind;
};
export type OpenFile = {
    id: string;
    filePath: string;
    relativePath: string;
    worktreeId: string;
    language: string;
    isDirty: boolean;
    diffSource?: DiffSource;
    branchCompare?: BranchCompareSnapshot;
    branchOldPath?: string;
    combinedAlternate?: CombinedDiffAlternate;
    combinedAreaFilter?: string;
    branchEntriesSnapshot?: GitBranchChangeEntry[];
    /** Why: snapshot uncommitted entries at tab-open time so a subsequent commit
     *  does not yank entries out from under the combined diff, which would rebuild
     *  all sections and lose loaded content + scroll position. */
    uncommittedEntriesSnapshot?: GitStatusEntry[];
    conflict?: OpenConflictMetadata;
    skippedConflicts?: CombinedDiffSkippedConflict[];
    conflictReview?: ConflictReviewState;
    isPreview?: boolean;
    isUntitled?: boolean;
    mode: 'edit' | 'diff' | 'conflict-review' | 'diff-comments';
};
export type RightSidebarTab = 'explorer' | 'search' | 'source-control' | 'checks';
export type ActivityBarPosition = 'top' | 'side';
export type MarkdownViewMode = 'source' | 'rich';
/** Enough state to restore a tab via `openFile` after `closeFile` (id is always filePath). */
export type ClosedEditorTabSnapshot = Omit<OpenFile, 'id' | 'isDirty'>;
export type EditorSlice = {
    editorDrafts: Record<string, string>;
    setEditorDraft: (fileId: string, content: string) => void;
    clearEditorDraft: (fileId: string) => void;
    clearEditorDrafts: (fileIds: string[]) => void;
    markdownViewMode: Record<string, MarkdownViewMode>;
    setMarkdownViewMode: (fileId: string, mode: MarkdownViewMode) => void;
    rightSidebarOpen: boolean;
    rightSidebarWidth: number;
    rightSidebarTab: RightSidebarTab;
    activityBarPosition: ActivityBarPosition;
    toggleRightSidebar: () => void;
    setRightSidebarOpen: (open: boolean) => void;
    setRightSidebarWidth: (width: number) => void;
    setRightSidebarTab: (tab: RightSidebarTab) => void;
    setActivityBarPosition: (position: ActivityBarPosition) => void;
    expandedDirs: Record<string, Set<string>>;
    toggleDir: (worktreeId: string, dirPath: string) => void;
    pendingExplorerReveal: {
        worktreeId: string;
        filePath: string;
        requestId: number;
        flash?: boolean;
    } | null;
    revealInExplorer: (worktreeId: string, filePath: string) => void;
    clearPendingExplorerReveal: () => void;
    openFiles: OpenFile[];
    activeFileId: string | null;
    activeFileIdByWorktree: Record<string, string | null>;
    activeTabTypeByWorktree: Record<string, WorkspaceVisibleTabType>;
    activeTabType: WorkspaceVisibleTabType;
    setActiveTabType: (type: WorkspaceVisibleTabType) => void;
    openFile: (file: Omit<OpenFile, 'id' | 'isDirty'>, options?: {
        preview?: boolean;
        targetGroupId?: string;
    }) => void;
    pinFile: (fileId: string, tabId?: string) => void;
    closeFile: (fileId: string) => void;
    closeAllFiles: () => void;
    /** Most recently closed editor tabs per worktree (for Cmd/Ctrl+Shift+T). */
    recentlyClosedEditorTabsByWorktree: Record<string, ClosedEditorTabSnapshot[]>;
    reopenClosedEditorTab: (worktreeId: string) => boolean;
    setActiveFile: (fileId: string) => void;
    reorderFiles: (fileIds: string[]) => void;
    markFileDirty: (fileId: string, dirty: boolean) => void;
    clearUntitled: (fileId: string) => void;
    openDiff: (worktreeId: string, filePath: string, relativePath: string, language: string, staged: boolean) => void;
    openBranchDiff: (worktreeId: string, worktreePath: string, entry: GitBranchChangeEntry, compare: GitBranchCompareSummary, language: string) => void;
    openAllDiffs: (worktreeId: string, worktreePath: string, alternate?: CombinedDiffAlternate, areaFilter?: string) => void;
    openConflictFile: (worktreeId: string, worktreePath: string, entry: GitStatusEntry, language: string) => void;
    openConflictReview: (worktreeId: string, worktreePath: string, entries: ConflictReviewEntry[], source: ConflictReviewState['source']) => void;
    openBranchAllDiffs: (worktreeId: string, worktreePath: string, compare: GitBranchCompareSummary, alternate?: CombinedDiffAlternate) => void;
    openDiffCommentsTab: (worktreeId: string, worktreePath: string) => void;
    editorCursorLine: Record<string, number>;
    setEditorCursorLine: (fileId: string, line: number) => void;
    gitStatusByWorktree: Record<string, GitStatusEntry[]>;
    gitConflictOperationByWorktree: Record<string, GitConflictOperation>;
    trackedConflictPathsByWorktree: Record<string, Record<string, GitConflictKind>>;
    trackConflictPath: (worktreeId: string, path: string, conflictKind: GitConflictKind) => void;
    setGitStatus: (worktreeId: string, status: GitStatusResult) => void;
    setConflictOperation: (worktreeId: string, operation: GitConflictOperation) => void;
    gitBranchChangesByWorktree: Record<string, GitBranchChangeEntry[]>;
    gitBranchCompareSummaryByWorktree: Record<string, GitBranchCompareSummary | null>;
    gitBranchCompareRequestKeyByWorktree: Record<string, string>;
    beginGitBranchCompareRequest: (worktreeId: string, requestKey: string, baseRef: string) => void;
    setGitBranchCompareResult: (worktreeId: string, requestKey: string, result: {
        summary: GitBranchCompareSummary;
        entries: GitBranchChangeEntry[];
    }) => void;
    fileSearchStateByWorktree: Record<string, {
        query: string;
        queryDetailsExpanded: boolean;
        caseSensitive: boolean;
        wholeWord: boolean;
        useRegex: boolean;
        includePattern: string;
        excludePattern: string;
        results: SearchResult | null;
        loading: boolean;
        collapsedFiles: Set<string>;
    }>;
    updateFileSearchState: (worktreeId: string, updates: Partial<EditorSlice['fileSearchStateByWorktree'][string]>) => void;
    toggleFileSearchCollapsedFile: (worktreeId: string, filePath: string) => void;
    clearFileSearch: (worktreeId: string) => void;
    pendingEditorReveal: {
        filePath: string;
        line: number;
        column: number;
        matchLength: number;
    } | null;
    setPendingEditorReveal: (reveal: {
        filePath: string;
        line: number;
        column: number;
        matchLength: number;
    } | null) => void;
    hydrateEditorSession: (session: WorkspaceSessionState) => void;
};
export declare const createEditorSlice: StateCreator<AppState, [], [], EditorSlice>;
export {};
