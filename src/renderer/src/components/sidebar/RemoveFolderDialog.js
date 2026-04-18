import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useCallback } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store';
const RemoveFolderDialog = React.memo(function RemoveFolderDialog() {
    const activeModal = useAppStore((s) => s.activeModal);
    const modalData = useAppStore((s) => s.modalData);
    const closeModal = useAppStore((s) => s.closeModal);
    const removeRepo = useAppStore((s) => s.removeRepo);
    const isOpen = activeModal === 'confirm-remove-folder';
    const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : '';
    const displayName = typeof modalData.displayName === 'string' ? modalData.displayName : '';
    const handleConfirm = useCallback(() => {
        if (repoId) {
            void removeRepo(repoId);
        }
        closeModal();
    }, [closeModal, removeRepo, repoId]);
    const handleOpenChange = useCallback((open) => {
        if (!open) {
            closeModal();
        }
    }, [closeModal]);
    return (_jsx(Dialog, { open: isOpen, onOpenChange: handleOpenChange, children: _jsxs(DialogContent, { className: "max-w-sm sm:max-w-sm", showCloseButton: false, children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { className: "text-sm", children: "Remove Folder" }), _jsxs(DialogDescription, { className: "text-xs", children: ["Remove ", _jsx("span", { className: "break-all font-medium text-foreground", children: displayName }), " from Orca? The folder will not be deleted from disk."] })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "outline", onClick: () => handleOpenChange(false), children: "Cancel" }), _jsx(Button, { variant: "destructive", onClick: handleConfirm, children: "Remove" })] })] }) }));
});
export default RemoveFolderDialog;
