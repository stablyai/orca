import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { FilePlus, FolderPlus } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
export function FileExplorerBackgroundMenu({ open, onOpenChange, point, worktreePath, onStartNew }) {
    return (_jsxs(DropdownMenu, { open: open, onOpenChange: onOpenChange, modal: false, children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsx("button", { "aria-hidden": true, tabIndex: -1, className: "pointer-events-none fixed size-px opacity-0", style: { left: point.x, top: point.y } }) }), _jsxs(DropdownMenuContent, { className: "w-48", sideOffset: 0, align: "start", onCloseAutoFocus: (e) => e.preventDefault(), children: [_jsxs(DropdownMenuItem, { onSelect: () => onStartNew('file', worktreePath, 0), children: [_jsx(FilePlus, {}), "New File"] }), _jsxs(DropdownMenuItem, { onSelect: () => onStartNew('folder', worktreePath, 0), children: [_jsx(FolderPlus, {}), "New Folder"] })] })] }));
}
