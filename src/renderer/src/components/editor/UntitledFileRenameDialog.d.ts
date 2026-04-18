import React from 'react';
type UntitledFileRenameDialogProps = {
    open: boolean;
    currentName: string;
    worktreePath: string;
    externalError?: string | null;
    onClose: () => void;
    onConfirm: (newRelativePath: string) => void;
};
export declare function UntitledFileRenameDialog({ open, currentName, worktreePath, externalError, onClose, onConfirm }: UntitledFileRenameDialogProps): React.JSX.Element;
export {};
