import { CircleCheckBig, CircleDot, CircleX, FolderGit2, GitPullRequest } from 'lucide-react';
import { branchName } from '@/lib/git-utils';
export { branchName };
export const PR_GROUP_ORDER = ['done', 'in-review', 'in-progress', 'closed'];
export const PR_GROUP_META = {
    done: {
        label: 'Done',
        icon: CircleCheckBig,
        tone: 'text-emerald-700 dark:text-emerald-200'
    },
    'in-review': {
        label: 'In review',
        icon: GitPullRequest,
        tone: 'text-sky-700 dark:text-sky-200'
    },
    'in-progress': {
        label: 'In progress',
        icon: CircleDot,
        tone: 'text-amber-700 dark:text-amber-200'
    },
    closed: {
        label: 'Closed',
        icon: CircleX,
        tone: 'text-zinc-600 dark:text-zinc-300'
    }
};
export const REPO_GROUP_META = {
    tone: 'text-foreground',
    icon: FolderGit2
};
export const PINNED_GROUP_KEY = 'pinned';
export const PINNED_GROUP_META = {
    label: 'Pinned',
    tone: 'text-muted-foreground'
};
export function getPRGroupKey(worktree, repoMap, prCache) {
    const repo = repoMap.get(worktree.repoId);
    const branch = branchName(worktree.branch);
    const cacheKey = repo && branch ? `${repo.path}::${branch}` : '';
    const prEntry = cacheKey && prCache
        ? prCache[cacheKey]
        : undefined;
    const pr = prEntry?.data;
    if (!pr) {
        return 'in-progress';
    }
    if (pr.state === 'merged') {
        return 'done';
    }
    if (pr.state === 'closed') {
        return 'closed';
    }
    if (pr.state === 'draft') {
        return 'in-progress';
    }
    return 'in-review';
}
/**
 * Emit a "Pinned" header + its items into `result`, returning the set of
 * pinned worktree IDs so the caller can exclude them from regular groups.
 */
function emitPinnedGroup(worktrees, repoMap, collapsedGroups, result) {
    const pinned = worktrees.filter((w) => w.isPinned);
    if (pinned.length === 0) {
        return new Set();
    }
    result.push({
        type: 'header',
        key: PINNED_GROUP_KEY,
        label: PINNED_GROUP_META.label,
        count: pinned.length,
        tone: PINNED_GROUP_META.tone
    });
    if (!collapsedGroups.has(PINNED_GROUP_KEY)) {
        for (const w of pinned) {
            result.push({ type: 'item', worktree: w, repo: repoMap.get(w.repoId) });
        }
    }
    return new Set(pinned.map((w) => w.id));
}
/**
 * Build the flat row list consumed by the virtualizer.
 * Extracted here to keep WorktreeList.tsx under the line-count lint limit.
 */
export function buildRows(groupBy, worktrees, repoMap, prCache, collapsedGroups) {
    const result = [];
    const pinnedIds = emitPinnedGroup(worktrees, repoMap, collapsedGroups, result);
    const unpinned = pinnedIds.size > 0 ? worktrees.filter((w) => !pinnedIds.has(w.id)) : worktrees;
    if (groupBy === 'none') {
        if (pinnedIds.size > 0 && unpinned.length > 0) {
            result.push({ type: 'separator', key: 'sep:pinned' });
        }
        for (const w of unpinned) {
            result.push({ type: 'item', worktree: w, repo: repoMap.get(w.repoId) });
        }
        return result;
    }
    const grouped = new Map();
    for (const w of unpinned) {
        let key;
        let label;
        let repo;
        if (groupBy === 'repo') {
            repo = repoMap.get(w.repoId);
            key = `repo:${w.repoId}`;
            label = repo?.displayName ?? 'Unknown';
        }
        else {
            const prGroup = getPRGroupKey(w, repoMap, prCache);
            key = `pr:${prGroup}`;
            label = PR_GROUP_META[prGroup].label;
        }
        if (!grouped.has(key)) {
            grouped.set(key, { label, items: [], repo });
        }
        grouped.get(key).items.push(w);
    }
    const orderedGroups = [];
    if (groupBy === 'pr-status') {
        for (const prGroup of PR_GROUP_ORDER) {
            const key = `pr:${prGroup}`;
            const group = grouped.get(key);
            if (group) {
                orderedGroups.push([key, group]);
            }
        }
    }
    else {
        orderedGroups.push(...Array.from(grouped.entries()));
    }
    for (const [key, group] of orderedGroups) {
        const isCollapsed = collapsedGroups.has(key);
        const repo = group.repo;
        const header = groupBy === 'repo'
            ? {
                type: 'header',
                key,
                label: group.label,
                count: group.items.length,
                tone: REPO_GROUP_META.tone,
                icon: REPO_GROUP_META.icon,
                repo
            }
            : (() => {
                const prGroup = key.replace(/^pr:/, '');
                const meta = PR_GROUP_META[prGroup];
                return {
                    type: 'header',
                    key,
                    label: meta.label,
                    count: group.items.length,
                    tone: meta.tone,
                    icon: meta.icon
                };
            })();
        result.push(header);
        if (!isCollapsed) {
            for (const w of group.items) {
                result.push({ type: 'item', worktree: w, repo: repoMap.get(w.repoId) });
            }
        }
    }
    return result;
}
/**
 * Returns true when the worktree matches the search query against any of:
 * displayName, branch, repo name, comment, PR number/title, issue number/title.
 * `q` must already be lowercased by the caller.
 */
export function matchesSearch(w, q, repoMap, prCache, issueCache) {
    // Cheap field checks first
    if (w.displayName.toLowerCase().includes(q)) {
        return true;
    }
    if (branchName(w.branch).toLowerCase().includes(q)) {
        return true;
    }
    if ((repoMap.get(w.repoId)?.displayName ?? '').toLowerCase().includes(q)) {
        return true;
    }
    if (w.comment && w.comment.toLowerCase().includes(q)) {
        return true;
    }
    // Strip leading '#' so that searching "#304" matches number 304.
    // Guard against bare '#' which would produce an empty string and match everything.
    const numQuery = q.startsWith('#') ? q.slice(1) : q;
    if (!numQuery) {
        return false;
    }
    // PR: check auto-detected PR from cache, then manual linkedPR as fallback
    const repo = repoMap.get(w.repoId);
    const branch = branchName(w.branch);
    const prKey = repo && branch ? `${repo.path}::${branch}` : '';
    const pr = prKey && prCache ? prCache[prKey]?.data : undefined;
    if (pr) {
        if (String(pr.number).includes(numQuery)) {
            return true;
        }
        if (pr.title.toLowerCase().includes(q)) {
            return true;
        }
    }
    else if (w.linkedPR != null) {
        if (String(w.linkedPR).includes(numQuery)) {
            return true;
        }
    }
    // Issue: check linkedIssue number and cached title
    if (w.linkedIssue != null) {
        if (String(w.linkedIssue).includes(numQuery)) {
            return true;
        }
        const issueKey = repo ? `${repo.path}::${w.linkedIssue}` : '';
        const issue = issueKey && issueCache ? issueCache[issueKey]?.data : undefined;
        if (issue?.title.toLowerCase().includes(q)) {
            return true;
        }
    }
    return false;
}
export function getGroupKeyForWorktree(groupBy, worktree, repoMap, prCache) {
    if (groupBy === 'none') {
        return null;
    }
    if (groupBy === 'repo') {
        return `repo:${worktree.repoId}`;
    }
    return `pr:${getPRGroupKey(worktree, repoMap, prCache)}`;
}
