import React from 'react';
import type { PendingDelete } from './file-explorer-types';
type FileDeleteDialogProps = {
    pendingDelete: PendingDelete | null;
    isDeleting: boolean;
    deleteDescription: string;
    deleteActionLabel: string;
    onClose: () => void;
    onConfirm: () => void;
};
export declare function FileDeleteDialog({ pendingDelete, isDeleting, deleteDescription, deleteActionLabel, onClose, onConfirm }: FileDeleteDialogProps): React.JSX.Element;
export {};
