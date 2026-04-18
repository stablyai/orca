import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useAppStore } from '@/store';
import { dirname } from '@/lib/path';
import { getConnectionId } from '@/lib/connection-context';
import { isPathEqualOrDescendant } from './file-explorer-paths';
import { requestEditorSaveQuiesce } from '@/components/editor/editor-autosave';
import { commitFileExplorerOp } from './fileExplorerUndoRedo';
function getDeleteDescription(pendingDelete, isWindows) {
    if (!pendingDelete) {
        return '';
    }
    const destination = isWindows ? 'the Recycle Bin' : 'the Trash';
    const { node } = pendingDelete;
    if (node.isDirectory) {
        return `Are you sure you want to move '${node.name}' and its contents to ${destination}?`;
    }
    return `Are you sure you want to move '${node.name}' to ${destination}?`;
}
export function useFileDeletion({ activeWorktreeId, openFiles, closeFile, refreshDir, selectedPath, setSelectedPath, isMac, isWindows }) {
    const [pendingDelete, setPendingDelete] = useState(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const requestDelete = useCallback((node) => {
        setSelectedPath(node.path);
        setPendingDelete({ node });
    }, [setSelectedPath]);
    const closeDeleteDialog = useCallback(() => {
        setPendingDelete(null);
    }, []);
    const confirmDelete = useCallback(async () => {
        if (!pendingDelete) {
            return;
        }
        const { node } = pendingDelete;
        setIsDeleting(true);
        try {
            const filesToClose = openFiles.filter((file) => isPathEqualOrDescendant(file.filePath, node.path));
            // Why: moving a file to Trash/Recycle Bin is another external mutation of
            // the file path. Let any in-flight autosave finish first so the delete
            // action cannot be undone by a trailing write that recreates the file.
            await Promise.all(filesToClose.map((file) => requestEditorSaveQuiesce({ fileId: file.id })));
            const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined;
            const parentDir = dirname(node.path);
            // Why: read file content before deleting so undo can restore it.
            // We capture content first but only commit the undo entry after the
            // delete succeeds — otherwise a failed delete would poison the stack.
            let undoContent;
            if (!node.isDirectory) {
                try {
                    const rf = await window.api.fs.readFile({ filePath: node.path, connectionId });
                    if (!rf.isBinary) {
                        undoContent = rf.content;
                    }
                }
                catch {
                    // If we cannot read the file (race, permission), skip undo recording
                    // so a failed undo cannot restore stale content.
                }
            }
            await window.api.fs.deletePath({ targetPath: node.path, connectionId });
            if (undoContent !== undefined) {
                commitFileExplorerOp({
                    undo: async () => {
                        await window.api.fs.writeFile({
                            filePath: node.path,
                            content: undoContent,
                            connectionId
                        });
                        await refreshDir(parentDir);
                    },
                    redo: async () => {
                        await window.api.fs.deletePath({ targetPath: node.path, connectionId });
                        await refreshDir(parentDir);
                    }
                });
            }
            for (const file of filesToClose) {
                closeFile(file.id);
            }
            if (activeWorktreeId) {
                useAppStore.setState((state) => {
                    const currentExpanded = state.expandedDirs[activeWorktreeId] ?? new Set();
                    const nextExpanded = new Set(Array.from(currentExpanded).filter((dirPath) => !isPathEqualOrDescendant(dirPath, node.path)));
                    if (nextExpanded.size === currentExpanded.size) {
                        return state;
                    }
                    return {
                        expandedDirs: {
                            ...state.expandedDirs,
                            [activeWorktreeId]: nextExpanded
                        }
                    };
                });
            }
            setPendingDelete(null);
            if (selectedPath && isPathEqualOrDescendant(selectedPath, node.path)) {
                setSelectedPath(null);
            }
            // Why: use targeted refreshDir instead of refreshTree so only the parent
            // directory is reloaded, preserving scroll position and avoiding redundant
            // full-tree reloads (the watcher will also trigger a targeted refresh).
            await refreshDir(dirname(node.path));
        }
        catch (error) {
            const action = isWindows ? 'move to Recycle Bin' : 'move to Trash';
            toast.error(error instanceof Error ? error.message : `Failed to ${action} '${node.name}'.`);
        }
        finally {
            setIsDeleting(false);
        }
    }, [
        activeWorktreeId,
        closeFile,
        isWindows,
        openFiles,
        pendingDelete,
        refreshDir,
        selectedPath,
        setSelectedPath
    ]);
    const deleteActionLabel = isWindows ? 'Move to Recycle Bin' : 'Move to Trash';
    return useMemo(() => ({
        pendingDelete,
        isDeleting,
        deleteShortcutLabel: isMac ? '⌘⌫ / Del' : 'Del',
        deleteActionLabel,
        deleteDescription: getDeleteDescription(pendingDelete, isWindows),
        requestDelete,
        closeDeleteDialog,
        confirmDelete
    }), [
        closeDeleteDialog,
        confirmDelete,
        deleteActionLabel,
        isMac,
        isDeleting,
        isWindows,
        pendingDelete,
        requestDelete
    ]);
}
