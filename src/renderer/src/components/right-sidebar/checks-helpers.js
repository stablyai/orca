import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/* eslint-disable max-lines -- Why: co-locating all checks-panel sub-components (checks list,
conflict sections, threaded PR comments) keeps the shared icon/color maps in one place. */
import React, { useCallback, useState } from 'react';
import { CircleCheck, CircleX, LoaderCircle, CircleDashed, CircleMinus, GitPullRequest, Files, Copy, Check, MessageSquare } from 'lucide-react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
export const PullRequestIcon = GitPullRequest;
export const CHECK_ICON = {
    success: CircleCheck,
    failure: CircleX,
    pending: LoaderCircle,
    neutral: CircleDashed,
    skipped: CircleMinus,
    cancelled: CircleX,
    timed_out: CircleX
};
export const CHECK_COLOR = {
    success: 'text-emerald-500',
    failure: 'text-rose-500',
    pending: 'text-amber-500',
    neutral: 'text-muted-foreground',
    skipped: 'text-muted-foreground/60',
    cancelled: 'text-muted-foreground/60',
    timed_out: 'text-rose-500'
};
export function ConflictingFilesSection({ pr }) {
    const files = pr.conflictSummary?.files ?? [];
    if (pr.mergeable !== 'CONFLICTING' || files.length === 0) {
        return null;
    }
    return (_jsxs("div", { className: "border-t border-border px-3 py-3", children: [_jsx("div", { className: "text-[11px] font-medium text-foreground", children: "This branch has conflicts that must be resolved" }), _jsxs("div", { className: "mt-1 text-[11px] text-muted-foreground", children: ["It's ", pr.conflictSummary.commitsBehind, " commit", pr.conflictSummary.commitsBehind === 1 ? '' : 's', " behind (base commit:", ' ', _jsx("span", { className: "font-mono text-[10px]", children: pr.conflictSummary.baseCommit }), ")"] }), _jsxs("div", { className: "mt-2 flex items-center gap-2", children: [_jsx(Files, { className: "size-3.5 shrink-0 text-muted-foreground" }), _jsx("div", { className: "text-[11px] text-muted-foreground", children: "Conflicting files" })] }), _jsx("div", { className: "mt-2 space-y-2", children: files.map((filePath) => (_jsx("div", { className: "rounded-md border border-border bg-accent/20 px-2.5 py-2", children: _jsx("div", { className: "break-all font-mono text-[11px] leading-4 text-foreground", children: filePath }) }, filePath))) })] }));
}
/** Fallback shown when GitHub reports merge conflicts but no file list is available yet. */
export function MergeConflictNotice({ pr }) {
    if (pr.mergeable !== 'CONFLICTING' || (pr.conflictSummary?.files.length ?? 0) > 0) {
        return null;
    }
    return (_jsxs("div", { className: "border-t border-border px-3 py-3", children: [_jsx("div", { className: "text-[11px] font-medium text-foreground", children: "This branch has conflicts that must be resolved" }), _jsx("div", { className: "mt-1 text-[11px] text-muted-foreground", children: "Refreshing conflict details\u2026" })] }));
}
const CHECK_SORT_ORDER = {
    failure: 0,
    timed_out: 0,
    cancelled: 1,
    pending: 2,
    neutral: 3,
    skipped: 4,
    success: 5
};
/** Renders the checks summary bar + scrollable check list. */
export function ChecksList({ checks, checksLoading }) {
    const sorted = [...checks].sort((a, b) => (CHECK_SORT_ORDER[a.conclusion ?? 'pending'] ?? 3) -
        (CHECK_SORT_ORDER[b.conclusion ?? 'pending'] ?? 3));
    const passingCount = checks.filter((c) => c.conclusion === 'success').length;
    const failingCount = checks.filter((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out').length;
    const pendingCount = checks.filter((c) => c.conclusion === 'pending' || c.conclusion === null).length;
    return (_jsxs(_Fragment, { children: [checks.length > 0 && (_jsxs("div", { className: "flex items-center gap-3 px-3 py-2 border-b border-border text-[10px] text-muted-foreground", children: [passingCount > 0 && (_jsxs("span", { className: "flex items-center gap-1", children: [_jsx(CircleCheck, { className: "size-3 text-emerald-500" }), passingCount, " passing"] })), failingCount > 0 && (_jsxs("span", { className: "flex items-center gap-1", children: [_jsx(CircleX, { className: "size-3 text-rose-500" }), failingCount, " failing"] })), pendingCount > 0 && (_jsxs("span", { className: "flex items-center gap-1", children: [_jsx(LoaderCircle, { className: "size-3 text-amber-500" }), pendingCount, " pending"] }))] })), checksLoading && checks.length === 0 ? (_jsx("div", { className: "flex items-center justify-center py-8", children: _jsx(LoaderCircle, { className: "size-5 animate-spin text-muted-foreground" }) })) : checks.length === 0 ? (_jsx("div", { className: "flex items-center justify-center py-8 text-[11px] text-muted-foreground", children: "No checks configured" })) : (_jsx("div", { className: "py-1", children: sorted.map((check) => {
                    const conclusion = check.conclusion ?? 'pending';
                    const Icon = CHECK_ICON[conclusion] ?? CircleDashed;
                    const color = CHECK_COLOR[conclusion] ?? 'text-muted-foreground';
                    return (_jsxs("div", { className: cn('flex items-center gap-2 px-3 py-1.5 hover:bg-accent/40 transition-colors', check.url && 'cursor-pointer'), onClick: () => {
                            if (check.url) {
                                window.api.shell.openUrl(check.url);
                            }
                        }, children: [_jsx(Icon, { className: cn('size-3.5 shrink-0', color, conclusion === 'pending' && 'animate-spin') }), _jsx("span", { className: "flex-1 truncate text-[12px] text-foreground", children: check.name }), check.url && _jsx(ExternalLink, { className: "size-3 text-muted-foreground/40 shrink-0" })] }, check.name));
                }) }))] }));
}
function CopyButton({ text }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = useCallback((e) => {
        e.stopPropagation();
        void window.api.ui.writeClipboardText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        });
    }, [text]);
    return (_jsx("button", { className: "p-1 rounded hover:bg-accent text-muted-foreground/40 hover:text-foreground transition-colors shrink-0", title: "Copy comment", onClick: handleCopy, children: copied ? _jsx(Check, { className: "size-3" }) : _jsx(Copy, { className: "size-3" }) }));
}
function ResolveButton({ threadId, isResolved, onResolve }) {
    const [loading, setLoading] = useState(false);
    const handleClick = useCallback((e) => {
        e.stopPropagation();
        setLoading(true);
        onResolve(threadId, !isResolved);
        setTimeout(() => setLoading(false), 300);
    }, [threadId, isResolved, onResolve]);
    if (loading) {
        return _jsx(LoaderCircle, { className: "size-3 animate-spin text-muted-foreground shrink-0" });
    }
    return (_jsx("button", { className: "text-[10px] px-1.5 py-0.5 rounded transition-colors shrink-0 text-muted-foreground hover:text-foreground hover:bg-accent", onClick: handleClick, children: isResolved ? 'Unresolve' : 'Resolve' }));
}
/** Format a line range string like "L12" or "L5-L12". */
function formatLineRange(comment) {
    if (!comment.line) {
        return null;
    }
    if (comment.startLine && comment.startLine !== comment.line) {
        return `L${comment.startLine}-L${comment.line}`;
    }
    return `L${comment.line}`;
}
/** Build copy text that includes file location context for review comments. */
function buildCopyText(comment) {
    if (!comment.path) {
        return comment.body;
    }
    const lineRange = formatLineRange(comment);
    const location = lineRange ? `${comment.path}:${lineRange}` : comment.path;
    return `File: ${location}\n\n${comment.body}`;
}
/** A single comment row — used for both root and reply comments. */
function CommentRow({ comment, isReply, showResolve, onResolve }) {
    return (_jsx("div", { className: cn('flex items-start gap-2 py-1.5 hover:bg-accent/40 transition-colors cursor-pointer group/comment', isReply ? 'pl-7 pr-3' : 'px-3', comment.isResolved && 'opacity-50'), onClick: () => {
            if (comment.url) {
                window.api.shell.openUrl(comment.url);
            }
        }, children: _jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-1.5 min-w-0", children: [comment.authorAvatarUrl ? (_jsx("img", { src: comment.authorAvatarUrl, alt: comment.author, className: cn('rounded-full shrink-0', isReply ? 'size-3.5' : 'size-4') })) : (_jsx("div", { className: cn('rounded-full bg-muted shrink-0', isReply ? 'size-3.5' : 'size-4') })), _jsx("span", { className: cn('text-[11px] font-semibold shrink-0', comment.isResolved ? 'text-muted-foreground' : 'text-foreground'), children: comment.author }), !isReply && comment.path && (_jsxs("span", { className: "text-[10px] font-mono text-muted-foreground/60 truncate min-w-0", children: [comment.path.split('/').pop(), formatLineRange(comment) && `:${formatLineRange(comment)}`] })), _jsx("div", { className: "flex-1" }), _jsxs("div", { className: "flex items-center gap-0.5 opacity-0 group-hover/comment:opacity-100 transition-opacity", children: [showResolve && comment.threadId != null && onResolve && (_jsx(ResolveButton, { threadId: comment.threadId, isResolved: comment.isResolved ?? false, onResolve: onResolve })), _jsx(CopyButton, { text: buildCopyText(comment) })] })] }), _jsx("p", { className: cn('text-[11px] text-muted-foreground leading-snug mt-0.5', isReply ? 'pl-5 line-clamp-1' : 'pl-[22px] line-clamp-2'), children: comment.body })] }) }));
}
/** Groups comments by threadId. Comments without a threadId are standalone. */
function groupComments(comments) {
    const groups = [];
    const threadMap = new Map();
    // Why: preserve insertion order so threads appear in the order their first
    // comment was created (the comments array is already sorted by createdAt).
    const threadOrder = [];
    for (const comment of comments) {
        if (!comment.threadId) {
            groups.push({ kind: 'standalone', comment });
            continue;
        }
        const existing = threadMap.get(comment.threadId);
        if (existing) {
            existing.replies.push(comment);
        }
        else {
            threadMap.set(comment.threadId, { root: comment, replies: [] });
            threadOrder.push(comment.threadId);
        }
    }
    // Interleave threads at the position of their first comment.
    // Walk the original comment list and emit each thread/standalone once.
    const emitted = new Set();
    const result = [];
    for (const comment of comments) {
        if (!comment.threadId) {
            result.push({ kind: 'standalone', comment });
        }
        else if (!emitted.has(comment.threadId)) {
            emitted.add(comment.threadId);
            const thread = threadMap.get(comment.threadId);
            result.push({ kind: 'thread', threadId: comment.threadId, ...thread });
        }
    }
    return result;
}
/** Renders the PR comments section below checks. */
export function PRCommentsList({ comments, commentsLoading, onResolve }) {
    const groups = React.useMemo(() => groupComments(comments), [comments]);
    return (_jsxs("div", { className: "border-t border-border", children: [_jsxs("div", { className: "flex items-center gap-2 px-3 py-2 border-b border-border", children: [_jsx(MessageSquare, { className: "size-3.5 text-muted-foreground" }), _jsx("span", { className: "text-[11px] font-medium text-foreground", children: "Comments" }), comments.length > 0 && (_jsx("span", { className: "text-[10px] text-muted-foreground", children: comments.length }))] }), commentsLoading && comments.length === 0 ? (_jsx("div", { className: "flex items-center justify-center py-6", children: _jsx(LoaderCircle, { className: "size-4 animate-spin text-muted-foreground" }) })) : comments.length === 0 ? (_jsx("div", { className: "flex items-center justify-center py-6 text-[11px] text-muted-foreground", children: "No comments" })) : (_jsx("div", { className: "py-1", children: groups.map((group) => {
                    if (group.kind === 'standalone') {
                        return (_jsx(CommentRow, { comment: group.comment, isReply: false, showResolve: false, onResolve: onResolve }, group.comment.id));
                    }
                    return (_jsxs("div", { className: "py-0.5", children: [_jsx(CommentRow, { comment: group.root, isReply: false, showResolve: true, onResolve: onResolve }), group.replies.length > 0 && (_jsx("div", { className: "ml-3 border-l-2 border-border/50", children: group.replies.map((reply) => (_jsx(CommentRow, { comment: reply, isReply: true, showResolve: false, onResolve: onResolve }, reply.id))) }))] }, group.threadId));
                }) }))] }));
}
export function prStateColor(state) {
    switch (state) {
        case 'merged':
            return 'bg-purple-500/15 text-purple-500 border-purple-500/20';
        case 'open':
            return 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20';
        case 'closed':
            return 'bg-muted text-muted-foreground border-border';
        case 'draft':
            return 'bg-muted text-muted-foreground/70 border-border';
    }
}
