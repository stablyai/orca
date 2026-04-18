import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Clipboard, Copy, Eraser, Maximize2, Minimize2, PanelBottomClose, PanelRightClose, Pencil, X } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { shouldIgnoreTerminalMenuPointerDownOutside } from './terminal-context-menu-dismiss';
export default function TerminalContextMenu({ open, onOpenChange, menuPoint, menuOpenedAtRef, canClosePane, canExpandPane, menuPaneIsExpanded, onCopy, onPaste, onSplitRight, onSplitDown, onClosePane, onClearScreen, onToggleExpand, onSetTitle }) {
    const isMac = navigator.userAgent.includes('Mac');
    const mod = isMac ? '⌘' : 'Ctrl+';
    const shift = isMac ? '⇧' : 'Shift+';
    return (_jsxs(DropdownMenu, { open: open, onOpenChange: (nextOpen) => {
            if (!nextOpen && Date.now() - menuOpenedAtRef.current < 100) {
                return;
            }
            onOpenChange(nextOpen);
        }, modal: false, children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsx("button", { "aria-hidden": true, tabIndex: -1, className: "pointer-events-none absolute size-px opacity-0", style: { left: menuPoint.x, top: menuPoint.y } }) }), _jsxs(DropdownMenuContent, { className: "w-52", sideOffset: 0, align: "start", onCloseAutoFocus: (e) => {
                    // Prevent Radix from moving focus back to the hidden trigger;
                    // let xterm keep focus naturally.
                    e.preventDefault();
                }, onFocusOutside: (e) => {
                    // xterm reclaims focus after the contextmenu event; don't let
                    // Radix treat that as a dismiss signal.
                    e.preventDefault();
                }, onPointerDownOutside: (e) => {
                    if (shouldIgnoreTerminalMenuPointerDownOutside({
                        openedAtMs: menuOpenedAtRef.current,
                        nowMs: Date.now()
                    })) {
                        e.preventDefault();
                    }
                }, children: [_jsxs(DropdownMenuItem, { onSelect: onCopy, children: [_jsx(Copy, {}), "Copy", _jsxs(DropdownMenuShortcut, { children: [mod, "C"] })] }), _jsxs(DropdownMenuItem, { onSelect: onPaste, children: [_jsx(Clipboard, {}), "Paste", _jsxs(DropdownMenuShortcut, { children: [mod, "V"] })] }), _jsx(DropdownMenuSeparator, {}), _jsxs(DropdownMenuItem, { onSelect: onSplitRight, children: [_jsx(PanelRightClose, {}), "Split Terminal Right", _jsx(DropdownMenuShortcut, { children: isMac ? `${mod}D` : `${mod}${shift}D` })] }), _jsxs(DropdownMenuItem, { onSelect: onSplitDown, children: [_jsx(PanelBottomClose, {}), "Split Terminal Down", _jsx(DropdownMenuShortcut, { children: isMac ? `${mod}${shift}D` : `Alt+${shift}D` })] }), canExpandPane && (_jsxs(DropdownMenuItem, { onSelect: onToggleExpand, children: [menuPaneIsExpanded ? _jsx(Minimize2, {}) : _jsx(Maximize2, {}), menuPaneIsExpanded ? 'Collapse Pane' : 'Expand Pane', _jsx(DropdownMenuShortcut, { children: `${mod}${shift}↩` })] })), _jsx(DropdownMenuSeparator, {}), _jsxs(DropdownMenuItem, { onSelect: onSetTitle, children: [_jsx(Pencil, {}), "Set Title\u2026"] }), canClosePane && (_jsxs(_Fragment, { children: [_jsx(DropdownMenuSeparator, {}), _jsxs(DropdownMenuItem, { variant: "destructive", onSelect: onClosePane, children: [_jsx(X, {}), "Close Pane", _jsxs(DropdownMenuShortcut, { children: [mod, "W"] })] })] })), _jsx(DropdownMenuSeparator, {}), _jsxs(DropdownMenuItem, { onSelect: onClearScreen, children: [_jsx(Eraser, {}), "Clear Screen"] })] })] }));
}
