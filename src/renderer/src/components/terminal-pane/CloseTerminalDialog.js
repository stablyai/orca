import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
export default function CloseTerminalDialog({ open, onCancel, onConfirm }) {
    return (_jsx(Dialog, { open: open, onOpenChange: (isOpen) => {
            if (!isOpen) {
                onCancel();
            }
        }, children: _jsxs(DialogContent, { className: "max-w-sm", showCloseButton: false, children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { className: "text-sm", children: "Close Terminal?" }), _jsx(DialogDescription, { className: "text-xs", children: "The terminal still has a running process. If you close the terminal, the process will be killed." })] }), _jsxs(DialogFooter, { className: "gap-2", children: [_jsx(Button, { type: "button", variant: "outline", size: "sm", onClick: onCancel, children: "Cancel" }), _jsx(Button, { type: "button", variant: "destructive", size: "sm", autoFocus: true, onClick: onConfirm, children: "Close" })] })] }) }));
}
