import React from 'react';
import type { PRInfo, PRCheckDetail, PRComment } from '../../../../shared/types';
export declare const PullRequestIcon: React.ForwardRefExoticComponent<Omit<import("lucide-react").LucideProps, "ref"> & React.RefAttributes<SVGSVGElement>>;
export declare const CHECK_ICON: Record<string, React.ComponentType<{
    className?: string;
}>>;
export declare const CHECK_COLOR: Record<string, string>;
export declare function ConflictingFilesSection({ pr }: {
    pr: PRInfo;
}): React.JSX.Element | null;
/** Fallback shown when GitHub reports merge conflicts but no file list is available yet. */
export declare function MergeConflictNotice({ pr }: {
    pr: PRInfo;
}): React.JSX.Element | null;
/** Renders the checks summary bar + scrollable check list. */
export declare function ChecksList({ checks, checksLoading }: {
    checks: PRCheckDetail[];
    checksLoading: boolean;
}): React.JSX.Element;
/** Renders the PR comments section below checks. */
export declare function PRCommentsList({ comments, commentsLoading, onResolve }: {
    comments: PRComment[];
    commentsLoading: boolean;
    onResolve?: (threadId: string, resolve: boolean) => void;
}): React.JSX.Element;
export declare function prStateColor(state: PRInfo['state']): string;
