import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useCallback } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store';
const NonGitFolderDialog = React.memo(function NonGitFolderDialog() {
    const activeModal = useAppStore((s) => s.activeModal);
    const modalData = useAppStore((s) => s.modalData);
    const closeModal = useAppStore((s) => s.closeModal);
    const addNonGitFolder = useAppStore((s) => s.addNonGitFolder);
    const isOpen = activeModal === 'confirm-non-git-folder';
    const folderPath = typeof modalData.folderPath === 'string' ? modalData.folderPath : '';
    const connectionId = typeof modalData.connectionId === 'string' ? modalData.connectionId : '';
    const handleConfirm = useCallback(() => {
        if (connectionId && folderPath) {
            void (async () => {
                try {
                    const result = await window.api.repos.addRemote({
                        connectionId,
                        remotePath: folderPath,
                        kind: 'folder'
                    });
                    if ('error' in result) {
                        throw new Error(result.error);
                    }
                    const repo = result.repo;
                    const state = useAppStore.getState();
                    if (!state.repos.some((r) => r.id === repo.id)) {
                        useAppStore.setState({ repos: [...state.repos, repo] });
                    }
                    await state.fetchWorktrees(repo.id);
                }
                catch (err) {
                    // This code path calls addRemote directly (not through the store),
                    // so the store's toast handling does not apply.
                    toast.error(err instanceof Error ? err.message : 'Failed to add remote folder');
                }
            })();
        }
        else if (folderPath) {
            void addNonGitFolder(folderPath);
        }
        closeModal();
    }, [addNonGitFolder, closeModal, folderPath, connectionId]);
    const handleOpenChange = useCallback((open) => {
        if (!open) {
            closeModal();
        }
    }, [closeModal]);
    return (_jsx(Dialog, { open: isOpen, onOpenChange: handleOpenChange, children: _jsxs(DialogContent, { className: "max-w-sm sm:max-w-sm", showCloseButton: false, children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { className: "text-sm", children: "Open as Folder" }), _jsx(DialogDescription, { className: "text-xs", children: "This folder isn't a Git repository. You'll have the editor, terminal, and search, but Git-based features won't be available." })] }), folderPath && (_jsx("div", { className: "rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs", children: _jsx("div", { className: "break-all text-muted-foreground", children: folderPath }) })), _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "outline", onClick: () => handleOpenChange(false), children: "Cancel" }), _jsx(Button, { onClick: handleConfirm, children: "Open as Folder" })] })] }) }));
});
export default NonGitFolderDialog;
