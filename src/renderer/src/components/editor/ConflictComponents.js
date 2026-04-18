import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { CircleCheck, GitMerge, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
export const CONFLICT_KIND_LABELS = {
    both_modified: 'Both modified',
    both_added: 'Both added',
    deleted_by_us: 'Deleted by us',
    deleted_by_them: 'Deleted by them',
    added_by_us: 'Added by us',
    added_by_them: 'Added by them',
    both_deleted: 'Both deleted'
};
export const CONFLICT_HINT_MAP = {
    both_modified: 'Resolve the conflict markers',
    both_added: 'Choose which version to keep, or combine them',
    deleted_by_us: 'Decide whether to restore the file',
    deleted_by_them: 'Decide whether to keep the file or accept deletion',
    added_by_us: 'Review whether to keep the added file',
    added_by_them: 'Review the added file before keeping it',
    both_deleted: 'Resolve in Git or restore one side before editing'
};
export function ConflictBanner({ file, entry }) {
    const conflict = file.conflict;
    if (!conflict) {
        return null;
    }
    const isUnresolved = conflict.conflictStatus === 'unresolved';
    const label = isUnresolved ? 'Unresolved' : 'Resolved locally';
    return (_jsxs("div", { className: cn('border-b px-4 py-2 text-xs', isUnresolved
            ? 'border-destructive/20 bg-destructive/5'
            : 'border-emerald-500/20 bg-emerald-500/5'), children: [_jsxs("div", { className: "flex items-center gap-2", children: [isUnresolved ? (_jsx(TriangleAlert, { className: "size-3.5 shrink-0 text-destructive" })) : (_jsx(CircleCheck, { className: "size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" })), _jsxs("span", { className: "font-medium text-foreground", children: [label, " conflict \u00B7 ", CONFLICT_KIND_LABELS[conflict.conflictKind]] })] }), !isUnresolved && (_jsx("div", { className: "mt-1 text-muted-foreground", children: "Session-local continuity state. Git is no longer reporting this file as unmerged." })), entry?.oldPath && (_jsxs("div", { className: "mt-1 text-muted-foreground", children: ["Renamed from ", entry.oldPath] }))] }));
}
export function ConflictPlaceholderView({ file }) {
    const conflict = file.conflict;
    if (!conflict) {
        return null;
    }
    return (_jsx("div", { className: "flex h-full items-center justify-center px-6 text-center", children: _jsxs("div", { className: "max-w-md space-y-2", children: [_jsx("div", { className: "text-sm font-medium text-foreground", children: CONFLICT_KIND_LABELS[conflict.conflictKind] }), _jsx("div", { className: "text-xs text-muted-foreground", children: conflict.message ?? 'No working-tree file is available to edit for this conflict.' }), _jsx("div", { className: "text-xs text-muted-foreground", children: conflict.guidance ?? CONFLICT_HINT_MAP[conflict.conflictKind] })] }) }));
}
export function ConflictReviewPanel({ file, liveEntries, onOpenEntry, onDismiss, onRefreshSnapshot, onReturnToSourceControl }) {
    const snapshotEntries = file.conflictReview?.entries ?? [];
    const liveEntriesByPath = new Map(liveEntries.map((entry) => [entry.path, entry]));
    const unresolvedSnapshotEntries = snapshotEntries.filter((entry) => liveEntriesByPath.get(entry.path)?.conflictStatus === 'unresolved');
    if (snapshotEntries.length > 0 && unresolvedSnapshotEntries.length === 0) {
        return (_jsx("div", { className: "flex h-full items-center justify-center px-6 text-center", children: _jsxs("div", { className: "max-w-md space-y-3", children: [_jsx("div", { className: "text-sm font-medium text-foreground", children: "All conflicts resolved" }), _jsx("div", { className: "text-xs text-muted-foreground", children: "This review snapshot no longer has any live unresolved conflicts." }), _jsxs("div", { className: "flex items-center justify-center gap-2", children: [_jsxs(Button, { type: "button", size: "sm", variant: "outline", onClick: onReturnToSourceControl, children: [_jsx(GitMerge, { className: "size-3.5" }), "Source Control"] }), _jsxs(Button, { type: "button", size: "sm", variant: "ghost", onClick: onDismiss, children: [_jsx(X, { className: "size-3.5" }), "Dismiss"] })] })] }) }));
    }
    return (_jsxs("div", { className: "h-full overflow-auto px-4 py-4", children: [_jsxs("div", { className: "mb-3", children: [_jsxs("div", { className: "text-sm font-medium text-foreground", children: [snapshotEntries.length, " unresolved conflict", snapshotEntries.length === 1 ? '' : 's'] }), _jsxs("div", { className: "mt-1 text-xs text-muted-foreground", children: ["Snapshot captured at", ' ', new Date(file.conflictReview?.snapshotTimestamp ?? Date.now()).toLocaleTimeString(), "."] }), _jsx("div", { className: "mt-2 flex items-center gap-2", children: _jsxs(Button, { type: "button", size: "sm", variant: "outline", onClick: onRefreshSnapshot, children: [_jsx(RefreshCw, { className: "size-3.5" }), "Refresh"] }) })] }), _jsx("div", { className: "space-y-2", children: snapshotEntries.map((snapshotEntry) => {
                    const liveEntry = liveEntriesByPath.get(snapshotEntry.path);
                    const isStillUnresolved = liveEntry?.conflictStatus === 'unresolved';
                    return (_jsxs("button", { type: "button", className: "flex w-full items-start justify-between rounded-md border border-border/60 px-3 py-2 text-left hover:bg-accent/30", onClick: () => {
                            if (liveEntry) {
                                onOpenEntry(liveEntry);
                            }
                        }, disabled: !liveEntry, children: [_jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "truncate text-sm text-foreground", children: snapshotEntry.path }), _jsxs("div", { className: "mt-1 text-xs text-muted-foreground", children: [CONFLICT_KIND_LABELS[snapshotEntry.conflictKind], " \u00B7", ' ', CONFLICT_HINT_MAP[snapshotEntry.conflictKind]] })] }), _jsx("span", { className: cn('ml-3 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold', isStillUnresolved
                                    ? 'bg-destructive/12 text-destructive'
                                    : 'bg-muted text-muted-foreground'), children: isStillUnresolved ? 'Unresolved' : liveEntry ? 'Resolved' : 'Gone' })] }, snapshotEntry.path));
                }) })] }));
}
