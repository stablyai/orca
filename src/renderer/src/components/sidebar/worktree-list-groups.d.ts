import type React from 'react';
import type { Repo, Worktree } from '../../../../shared/types';
import { branchName } from '@/lib/git-utils';
export { branchName };
export type GroupHeaderRow = {
    type: 'header';
    key: string;
    label: string;
    count: number;
    tone: string;
    icon?: React.ComponentType<{
        className?: string;
    }>;
    repo?: Repo;
};
export type SeparatorRow = {
    type: 'separator';
    key: string;
};
export type WorktreeRow = {
    type: 'item';
    worktree: Worktree;
    repo: Repo | undefined;
};
export type Row = GroupHeaderRow | SeparatorRow | WorktreeRow;
export type PRGroupKey = 'done' | 'in-review' | 'in-progress' | 'closed';
export declare const PR_GROUP_ORDER: PRGroupKey[];
export declare const PR_GROUP_META: Record<PRGroupKey, {
    label: string;
    icon: React.ComponentType<{
        className?: string;
    }>;
    tone: string;
}>;
export declare const REPO_GROUP_META: {
    readonly tone: "text-foreground";
    readonly icon: React.ForwardRefExoticComponent<Omit<import("lucide-react").LucideProps, "ref"> & React.RefAttributes<SVGSVGElement>>;
};
export declare const PINNED_GROUP_KEY = "pinned";
export declare const PINNED_GROUP_META: {
    readonly label: "Pinned";
    readonly tone: "text-muted-foreground";
};
export declare function getPRGroupKey(worktree: Worktree, repoMap: Map<string, Repo>, prCache: Record<string, unknown> | null): PRGroupKey;
/**
 * Build the flat row list consumed by the virtualizer.
 * Extracted here to keep WorktreeList.tsx under the line-count lint limit.
 */
export declare function buildRows(groupBy: 'none' | 'repo' | 'pr-status', worktrees: Worktree[], repoMap: Map<string, Repo>, prCache: Record<string, unknown> | null, collapsedGroups: Set<string>): Row[];
/**
 * Returns true when the worktree matches the search query against any of:
 * displayName, branch, repo name, comment, PR number/title, issue number/title.
 * `q` must already be lowercased by the caller.
 */
export declare function matchesSearch(w: Worktree, q: string, repoMap: Map<string, Repo>, prCache: Record<string, {
    data?: {
        number: number;
        title: string;
    } | null;
}> | null, issueCache: Record<string, {
    data?: {
        number: number;
        title: string;
    } | null;
}> | null): boolean;
export declare function getGroupKeyForWorktree(groupBy: 'none' | 'repo' | 'pr-status', worktree: Worktree, repoMap: Map<string, Repo>, prCache: Record<string, unknown> | null): string | null;
