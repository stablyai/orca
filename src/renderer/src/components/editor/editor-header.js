import { getEditorDisplayLabel } from './editor-labels';
export function getEditorHeaderCopyState(file) {
    if (file.mode === 'conflict-review') {
        return {
            copyText: file.filePath,
            copyToastLabel: 'Worktree path copied',
            pathLabel: 'Conflict Review',
            pathTitle: file.filePath
        };
    }
    const isCombinedDiff = file.mode === 'diff' &&
        (file.diffSource === 'combined-uncommitted' || file.diffSource === 'combined-branch');
    if (isCombinedDiff) {
        return {
            copyText: file.filePath,
            copyToastLabel: 'Worktree path copied',
            pathLabel: file.relativePath,
            pathTitle: file.filePath
        };
    }
    const displayLabel = getEditorDisplayLabel(file, 'fullPath');
    return {
        copyText: file.filePath,
        copyToastLabel: 'File path copied',
        pathLabel: displayLabel,
        pathTitle: displayLabel
    };
}
export function getEditorHeaderOpenFileState(file, worktreeEntry, branchEntry) {
    const isSingleDiff = file.mode === 'diff' &&
        file.diffSource !== undefined &&
        file.diffSource !== 'combined-uncommitted' &&
        file.diffSource !== 'combined-branch';
    if (!isSingleDiff) {
        return { canOpen: false };
    }
    if (file.diffSource === 'branch') {
        return { canOpen: branchEntry?.status !== 'deleted' || !branchEntry };
    }
    // Why: diff tabs can outlive the current Source Control snapshot. If the
    // live entry is missing, keep the action enabled instead of hiding a valid
    // open-file path just because sidebar polling has moved on.
    if (!worktreeEntry) {
        return { canOpen: true };
    }
    return { canOpen: worktreeEntry.status !== 'deleted' };
}
