import React from 'react';
import type { OpenFile } from '@/store/slices/editor';
import type { GitConflictKind, GitStatusEntry } from '../../../../shared/types';
export declare const CONFLICT_KIND_LABELS: Record<GitConflictKind, string>;
export declare const CONFLICT_HINT_MAP: Record<GitConflictKind, string>;
export declare function ConflictBanner({ file, entry }: {
    file: OpenFile;
    entry: GitStatusEntry | null;
}): React.JSX.Element | null;
export declare function ConflictPlaceholderView({ file }: {
    file: OpenFile;
}): React.JSX.Element | null;
export declare function ConflictReviewPanel({ file, liveEntries, onOpenEntry, onDismiss, onRefreshSnapshot, onReturnToSourceControl }: {
    file: OpenFile;
    liveEntries: GitStatusEntry[];
    onOpenEntry: (entry: GitStatusEntry) => void;
    onDismiss: () => void;
    onRefreshSnapshot: () => void;
    onReturnToSourceControl: () => void;
}): React.JSX.Element;
