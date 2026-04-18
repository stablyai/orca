/**
 * Electron's ipcRenderer.invoke wraps errors as:
 *   "Error invoking remote method 'channel': Error: actual message"
 * Strip the wrapper so users see only the meaningful part.
 */
export declare function extractIpcErrorMessage(err: unknown, fallback: string): string;
type RenameFileArgs = {
    oldPath: string;
    /** just the new filename (no directory) */
    newName: string;
    worktreeId: string;
    worktreePath: string;
    /** refresh the parent directory in the explorer tree, if caller tracks one */
    refreshDir?: (dirPath: string) => Promise<void>;
};
/**
 * Rename a file or directory on disk. Handles:
 *   - no-op when the name is unchanged
 *   - quiescing any in-flight autosave on open tabs under `oldPath`
 *     (so a trailing write can't recreate the old path post-rename)
 *   - remapping every affected open editor tab to the new path
 *   - committing an undo/redo pair via the file-explorer undo stack
 *   - unwrapped toast on IPC failure
 *
 * Used by the file-explorer inline rename and by double-click-rename
 * from an editor tab. Both entry points should go through here so
 * the tab-remap + quiesce behavior stays consistent.
 */
export declare function renameFileOnDisk(args: RenameFileArgs): Promise<void>;
export {};
