type UseFileExplorerImportParams = {
    worktreePath: string | null;
    activeWorktreeId: string | null;
    refreshDir: (dirPath: string) => Promise<void>;
    clearNativeDragState: () => void;
};
/**
 * Subscribes to native file-drop events targeted at the file explorer and
 * runs the import pipeline: copy into worktree, refresh, reveal.
 *
 * Why this is a separate hook: the actual filesystem paths from native OS
 * drops are only available through the preload-relayed IPC event, not the
 * React drop handler. The drop handler manages visual state; this hook
 * manages the import action.
 */
export declare function useFileExplorerImport({ worktreePath, activeWorktreeId, refreshDir, clearNativeDragState }: UseFileExplorerImportParams): void;
export {};
