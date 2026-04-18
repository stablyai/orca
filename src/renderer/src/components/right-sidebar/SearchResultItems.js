import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from 'react';
import { ChevronRight, Copy } from 'lucide-react';
import { basename, dirname } from '@/lib/path';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu';
// ─── Toggle Button ────────────────────────────────────────
export function ToggleButton({ active, onClick, title, children, ariaExpanded }) {
    return (_jsx(Button, { type: "button", variant: "ghost", size: "icon-xs", className: cn('h-auto w-auto rounded-sm p-0.5 flex-shrink-0', active
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted'), onClick: onClick, title: title, "aria-label": title, "aria-pressed": active, "aria-expanded": ariaExpanded, children: children }));
}
// ─── File Result ──────────────────────────────────────────
export function FileResultRow({ fileResult, onToggleCollapse, collapsed }) {
    const fileName = basename(fileResult.relativePath);
    const parentDir = dirname(fileResult.relativePath);
    const dirPath = parentDir === '.' ? '' : parentDir;
    return (_jsx("div", { className: "pt-1.5", children: _jsx(TooltipProvider, { delayDuration: 400, children: _jsxs(Tooltip, { children: [_jsxs(ContextMenu, { children: [_jsx(ContextMenuTrigger, { asChild: true, children: _jsx(TooltipTrigger, { asChild: true, children: _jsxs(Button, { type: "button", variant: "ghost", className: "h-auto w-full justify-start gap-1 rounded-none px-2 py-0.5 text-left group", onClick: onToggleCollapse, children: [_jsx(ChevronRight, { className: cn('size-3 flex-shrink-0 text-muted-foreground transition-transform', !collapsed && 'rotate-90') }), _jsx("div", { className: "min-w-0 flex-1 text-xs", children: _jsxs("span", { className: "min-w-0 block truncate", children: [_jsx("span", { className: "text-foreground", children: fileName }), dirPath && (_jsx("span", { className: "ml-1.5 text-[11px] text-muted-foreground", children: dirPath }))] }) }), _jsx("span", { className: "text-[10px] text-muted-foreground flex-shrink-0 bg-muted/80 rounded-full px-1.5", children: fileResult.matches.length })] }) }) }), _jsx(ContextMenuContent, { children: _jsxs(ContextMenuItem, { onClick: () => window.api.ui.writeClipboardText(fileResult.relativePath), children: [_jsx(Copy, { className: "size-3.5" }), "Copy Path"] }) })] }), _jsx(TooltipContent, { side: "top", sideOffset: 6, children: fileResult.relativePath })] }) }) }));
}
// ─── Match Item ───────────────────────────────────────────
export function MatchResultRow({ match, relativePath, onClick }) {
    // Highlight the matched text within the line
    const parts = useMemo(() => {
        const content = match.lineContent;
        const col = match.column - 1; // convert to 0-indexed
        const len = match.matchLength;
        if (col >= 0 && col + len <= content.length) {
            return {
                before: content.slice(0, col),
                match: content.slice(col, col + len),
                after: content.slice(col + len)
            };
        }
        // Fallback
        return { before: content, match: '', after: '' };
    }, [match.lineContent, match.column, match.matchLength]);
    return (_jsxs(ContextMenu, { children: [_jsx(ContextMenuTrigger, { asChild: true, children: _jsxs(Button, { type: "button", variant: "ghost", className: "min-h-[18px] h-auto w-full justify-start gap-1 rounded-none py-px pr-2 pl-7 text-left", onMouseDown: (event) => {
                        // Why: clicking a result should move focus into the opened editor.
                        // If the sidebar button takes focus first, the browser can restore
                        // it after the click and make the initial reveal feel flaky.
                        if (event.button === 0) {
                            event.preventDefault();
                        }
                    }, onClick: onClick, children: [_jsx("span", { className: "text-[10px] text-muted-foreground flex-shrink-0 tabular-nums mt-px", children: match.line }), _jsxs("span", { className: "text-xs truncate", children: [_jsx("span", { className: "text-muted-foreground", children: parts.before.trimStart() }), parts.match && (_jsx("span", { className: "bg-amber-500/30 text-foreground rounded-sm", children: parts.match })), _jsx("span", { className: "text-muted-foreground", children: parts.after })] })] }) }), _jsx(ContextMenuContent, { children: _jsxs(ContextMenuItem, { onClick: () => window.api.ui.writeClipboardText(`${relativePath}#L${match.line}`), children: [_jsx(Copy, { className: "size-3.5" }), "Copy Line Path"] }) })] }));
}
