import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
export function FileDeleteDialog({ pendingDelete, isDeleting, deleteDescription, deleteActionLabel, onClose, onConfirm }) {
    return (_jsx(Dialog, { open: pendingDelete !== null, onOpenChange: (open) => {
            if (!open) {
                onClose();
            }
        }, children: _jsxs(DialogContent, { showCloseButton: false, children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: deleteActionLabel }), _jsx(DialogDescription, { children: deleteDescription })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "outline", onClick: onClose, disabled: isDeleting, children: "Cancel" }), _jsx(Button, { onClick: onConfirm, disabled: isDeleting, children: isDeleting ? 'Deleting…' : deleteActionLabel })] })] }) }));
}
