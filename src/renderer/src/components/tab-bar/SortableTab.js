import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { X, Terminal as TerminalIcon, Minimize2, Columns2, Rows2 } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
export const TAB_COLORS = [
    { label: 'None', value: null },
    { label: 'Blue', value: '#3b82f6' },
    { label: 'Purple', value: '#a855f7' },
    { label: 'Pink', value: '#ec4899' },
    { label: 'Red', value: '#ef4444' },
    { label: 'Orange', value: '#f97316' },
    { label: 'Yellow', value: '#eab308' },
    { label: 'Green', value: '#22c55e' },
    { label: 'Teal', value: '#14b8a6' },
    { label: 'Gray', value: '#9ca3af' }
];
export const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus';
export default function SortableTab({ tab, tabCount, hasTabsToRight, isActive, isExpanded, onActivate, onClose, onCloseOthers, onCloseToRight, onSetCustomTitle, onSetTabColor, onToggleExpand, onSplitGroup, dragData }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: tab.id,
        data: dragData
    });
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
        opacity: isDragging ? 0.8 : 1
    };
    const [menuOpen, setMenuOpen] = useState(false);
    const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 });
    const [renameOpen, setRenameOpen] = useState(false);
    const [renameValue, setRenameValue] = useState('');
    const renameInputRef = useRef(null);
    const handleRenameOpen = useCallback(() => {
        setRenameValue(tab.customTitle ?? tab.title);
        setRenameOpen(true);
    }, [tab.customTitle, tab.title]);
    const handleRenameSubmit = useCallback(() => {
        const trimmed = renameValue.trim();
        onSetCustomTitle(tab.id, trimmed.length > 0 ? trimmed : null);
        setRenameOpen(false);
    }, [renameValue, onSetCustomTitle, tab.id]);
    useEffect(() => {
        if (!renameOpen) {
            return;
        }
        const frame = requestAnimationFrame(() => {
            renameInputRef.current?.focus();
            renameInputRef.current?.select();
        });
        return () => cancelAnimationFrame(frame);
    }, [renameOpen]);
    useEffect(() => {
        const closeMenu = () => setMenuOpen(false);
        window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu);
        return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu);
    }, []);
    return (_jsxs(_Fragment, { children: [_jsx("div", { onContextMenuCapture: (event) => {
                    event.preventDefault();
                    window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT));
                    setMenuPoint({ x: event.clientX, y: event.clientY });
                    setMenuOpen(true);
                }, children: _jsxs("div", { ref: setNodeRef, style: style, ...attributes, ...listeners, className: `group relative flex items-center h-full px-3 text-sm cursor-pointer select-none shrink-0 border-r border-border ${isActive
                        ? 'bg-accent/40 text-foreground border-b-transparent'
                        : 'bg-card text-muted-foreground hover:text-foreground hover:bg-accent/50'}`, onPointerDown: (e) => {
                        if (e.button !== 0) {
                            return;
                        }
                        onActivate(tab.id);
                        listeners?.onPointerDown?.(e);
                    }, onMouseDown: (e) => {
                        // Why: prevent default browser middle-click behavior (auto-scroll)
                        // but do NOT close here — closing removes the element before mouseup,
                        // causing the mouseup to fall through to the terminal and trigger
                        // an X11 primary selection paste on Linux.
                        if (e.button === 1) {
                            e.preventDefault();
                        }
                    }, onAuxClick: (e) => {
                        if (e.button === 1) {
                            e.preventDefault();
                            e.stopPropagation();
                            onClose(tab.id);
                        }
                    }, children: [_jsx(TerminalIcon, { className: `w-3.5 h-3.5 mr-1.5 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground'}` }), _jsx("span", { className: "truncate max-w-[130px] mr-1.5", children: tab.customTitle ?? tab.title }), tab.color && (_jsx("span", { className: "mr-1.5 size-2 rounded-full shrink-0", style: { backgroundColor: tab.color } })), isExpanded && (_jsx("button", { className: `mr-1 flex items-center justify-center w-4 h-4 rounded-sm shrink-0 ${isActive
                                ? 'text-muted-foreground hover:text-foreground hover:bg-muted'
                                : 'text-transparent group-hover:text-muted-foreground hover:!text-foreground hover:!bg-muted'}`, onPointerDown: (e) => e.stopPropagation(), onClick: (e) => {
                                e.stopPropagation();
                                onToggleExpand(tab.id);
                            }, title: "Collapse pane", "aria-label": "Collapse pane", children: _jsx(Minimize2, { className: "w-3 h-3" }) })), _jsx("button", { className: `flex items-center justify-center w-4 h-4 rounded-sm shrink-0 ${isActive
                                ? 'text-muted-foreground hover:text-foreground hover:bg-muted'
                                : 'text-transparent group-hover:text-muted-foreground hover:!text-foreground hover:!bg-muted'}`, onPointerDown: (e) => e.stopPropagation(), onClick: (e) => {
                                e.stopPropagation();
                                onClose(tab.id);
                            }, children: _jsx(X, { className: "w-3 h-3" }) })] }) }), _jsxs(DropdownMenu, { open: menuOpen, onOpenChange: setMenuOpen, modal: false, children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsx("button", { "aria-hidden": true, tabIndex: -1, className: "pointer-events-none fixed size-px opacity-0", style: { left: menuPoint.x, top: menuPoint.y } }) }), _jsxs(DropdownMenuContent, { className: "w-48", sideOffset: 0, align: "start", children: [_jsxs(DropdownMenuItem, { onSelect: () => onSplitGroup('up', tab.id), children: [_jsx(Rows2, { className: "mr-1.5 size-3.5" }), "Split Up"] }), _jsxs(DropdownMenuItem, { onSelect: () => onSplitGroup('down', tab.id), children: [_jsx(Rows2, { className: "mr-1.5 size-3.5" }), "Split Down"] }), _jsxs(DropdownMenuItem, { onSelect: () => onSplitGroup('left', tab.id), children: [_jsx(Columns2, { className: "mr-1.5 size-3.5" }), "Split Left"] }), _jsxs(DropdownMenuItem, { onSelect: () => onSplitGroup('right', tab.id), children: [_jsx(Columns2, { className: "mr-1.5 size-3.5" }), "Split Right"] }), _jsx(DropdownMenuSeparator, {}), _jsx(DropdownMenuItem, { onSelect: () => onClose(tab.id), children: "Close" }), _jsx(DropdownMenuItem, { onSelect: () => onCloseOthers(tab.id), disabled: tabCount <= 1, children: "Close Others" }), _jsx(DropdownMenuItem, { onSelect: () => onCloseToRight(tab.id), disabled: !hasTabsToRight, children: "Close Tabs To The Right" }), _jsx(DropdownMenuSeparator, {}), _jsx(DropdownMenuItem, { onSelect: handleRenameOpen, children: "Change Title" }), _jsxs("div", { className: "px-2 pt-1.5 pb-1", children: [_jsx("div", { className: "text-xs font-medium text-muted-foreground mb-1.5", children: "Tab Color" }), _jsx("div", { className: "flex flex-wrap gap-2", children: TAB_COLORS.map((color) => {
                                            const isSelected = tab.color === color.value;
                                            return (_jsx(DropdownMenuItem, { className: `relative h-4 w-4 min-w-4 p-0 rounded-full border ${isSelected
                                                    ? 'ring-1 ring-foreground/70 ring-offset-1 ring-offset-popover'
                                                    : ''} ${color.value
                                                    ? 'border-transparent'
                                                    : 'border-muted-foreground/50 bg-transparent'}`, style: color.value ? { backgroundColor: color.value } : undefined, onSelect: () => {
                                                    onSetTabColor(tab.id, color.value);
                                                }, children: color.value === null && (_jsx("span", { className: "absolute block h-px w-3 rotate-45 bg-muted-foreground/80" })) }, color.label));
                                        }) })] })] })] }), _jsx(Dialog, { open: renameOpen, onOpenChange: setRenameOpen, children: _jsxs(DialogContent, { className: "max-w-sm", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { className: "text-sm", children: "Change Tab Title" }), _jsx(DialogDescription, { className: "text-xs", children: "Leave empty to reset to the default title." })] }), _jsxs("form", { className: "space-y-3", onSubmit: (event) => {
                                event.preventDefault();
                                handleRenameSubmit();
                            }, children: [_jsx(Input, { ref: renameInputRef, value: renameValue, onChange: (event) => setRenameValue(event.target.value), className: "h-8 text-xs", autoFocus: true }), _jsxs(DialogFooter, { children: [_jsx(Button, { type: "button", variant: "outline", size: "sm", onClick: () => setRenameOpen(false), children: "Cancel" }), _jsx(Button, { type: "submit", size: "sm", children: "Save" })] })] })] }) })] }));
}
