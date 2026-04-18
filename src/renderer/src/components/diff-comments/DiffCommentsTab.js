import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from 'react';
import { Trash2, MessageSquare, Terminal, Play, Clipboard } from 'lucide-react';
import { useAppStore } from '@/store';
import { Button } from '@/components/ui/button';
import { formatDiffComments } from '@/lib/diff-comments-format';
import { DiffCommentsAgentChooserDialog } from './DiffCommentsAgentChooserDialog';
function formatTimestamp(ts) {
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) {
        return 'just now';
    }
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours}h ago`;
    }
    const days = Math.floor(hours / 24);
    if (days < 7) {
        return `${days}d ago`;
    }
    return new Date(ts).toLocaleDateString();
}
function groupByFile(comments) {
    const groups = {};
    for (const c of comments) {
        if (!groups[c.filePath]) {
            groups[c.filePath] = [];
        }
        groups[c.filePath].push(c);
    }
    for (const list of Object.values(groups)) {
        list.sort((a, b) => a.lineNumber - b.lineNumber);
    }
    return groups;
}
export function DiffCommentsTab({ activeFile }) {
    const worktreeId = activeFile.worktreeId;
    const comments = useAppStore((s) => s.getDiffComments(worktreeId));
    const deleteDiffComment = useAppStore((s) => s.deleteDiffComment);
    const clearDiffComments = useAppStore((s) => s.clearDiffComments);
    const getActiveTab = useAppStore((s) => s.getActiveTab);
    const [agentDialogOpen, setAgentDialogOpen] = useState(false);
    const [pasteNotice, setPasteNotice] = useState(null);
    const groups = useMemo(() => groupByFile(comments), [comments]);
    const fileEntries = useMemo(() => Object.entries(groups), [groups]);
    const handlePaste = () => {
        if (comments.length === 0) {
            return;
        }
        const text = formatDiffComments(comments);
        // Why: the user's request is "paste" — don't send a trailing carriage return
        // so the AI CLI user can review the text in the terminal before submitting.
        const state = useAppStore.getState();
        const active = getActiveTab(worktreeId);
        if (!active || active.contentType !== 'terminal') {
            setPasteNotice('Focus a terminal tab in this worktree before pasting.');
            return;
        }
        const ptyId = state.ptyIdsByTabId[active.entityId]?.[0];
        if (!ptyId) {
            setPasteNotice('Active terminal has no running PTY.');
            return;
        }
        window.api.pty.write(ptyId, text);
        setPasteNotice(`Pasted ${comments.length} comment${comments.length === 1 ? '' : 's'}.`);
    };
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col bg-background", children: [_jsxs("div", { className: "flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2", children: [_jsx(MessageSquare, { className: "size-4 text-muted-foreground" }), _jsxs("div", { className: "text-sm font-medium", children: ["Diff Comments (", comments.length, ")"] }), _jsxs("div", { className: "ml-auto flex items-center gap-1.5", children: [_jsxs(Button, { size: "sm", variant: "outline", onClick: handlePaste, disabled: comments.length === 0, title: "Paste formatted comments into the active terminal (no newline sent)", children: [_jsx(Clipboard, { className: "size-3.5" }), "Paste into terminal"] }), _jsxs(Button, { size: "sm", onClick: () => setAgentDialogOpen(true), disabled: comments.length === 0, title: "Start a new terminal tab with an agent preloaded with these comments", children: [_jsx(Play, { className: "size-3.5" }), "Start agent with comments"] }), _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => {
                                    if (comments.length === 0) {
                                        return;
                                    }
                                    if (confirm(`Delete all ${comments.length} comments for this worktree?`)) {
                                        void clearDiffComments(worktreeId);
                                    }
                                }, disabled: comments.length === 0, children: [_jsx(Trash2, { className: "size-3.5" }), "Clear all"] })] })] }), pasteNotice && (_jsx("div", { className: "shrink-0 border-b border-border/60 bg-accent/30 px-3 py-1.5 text-xs text-muted-foreground", children: pasteNotice })), _jsx("div", { className: "flex-1 overflow-y-auto", children: fileEntries.length === 0 ? (_jsx("div", { className: "flex h-full items-center justify-center p-8 text-sm text-muted-foreground", children: "No comments yet. Hover a line in the diff view and click the + in the gutter." })) : (_jsx("div", { className: "divide-y divide-border/60", children: fileEntries.map(([filePath, list]) => (_jsxs("section", { className: "px-3 py-2", children: [_jsxs("header", { className: "mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground", children: [_jsx(Terminal, { className: "size-3" }), _jsx("span", { className: "truncate", children: filePath }), _jsxs("span", { className: "tabular-nums", children: ["(", list.length, ")"] })] }), _jsx("ul", { className: "space-y-1.5", children: list.map((c) => (_jsxs("li", { className: "group flex items-start gap-2 rounded-md border border-border/50 bg-card px-2.5 py-1.5", children: [_jsxs("span", { className: "mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground", children: ["L", c.lineNumber] }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "whitespace-pre-wrap break-words text-xs leading-relaxed", children: c.body }), _jsx("div", { className: "mt-0.5 text-[10px] text-muted-foreground", children: formatTimestamp(c.createdAt) })] }), _jsx("button", { type: "button", className: "mt-0.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100", onClick: () => void deleteDiffComment(worktreeId, c.id), title: "Delete comment", children: _jsx(Trash2, { className: "size-3.5" }) })] }, c.id))) })] }, filePath))) })) }), _jsx(DiffCommentsAgentChooserDialog, { open: agentDialogOpen, onOpenChange: setAgentDialogOpen, worktreeId: worktreeId, comments: comments })] }));
}
