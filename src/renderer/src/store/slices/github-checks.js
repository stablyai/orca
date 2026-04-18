export function normalizeBranchName(branch) {
    return branch.replace(/^refs\/heads\//, '');
}
export function deriveCheckStatusFromChecks(checks) {
    if (checks.length === 0) {
        return 'neutral';
    }
    let hasPending = false;
    for (const check of checks) {
        if (check.conclusion === 'failure' ||
            check.conclusion === 'timed_out' ||
            check.conclusion === 'cancelled') {
            return 'failure';
        }
        if (check.status === 'queued' ||
            check.status === 'in_progress' ||
            check.conclusion === 'pending') {
            hasPending = true;
        }
    }
    return hasPending ? 'pending' : 'success';
}
export function syncPRChecksStatus(state, repoPath, branch, checks) {
    const normalized = branch ? normalizeBranchName(branch) : '';
    if (!normalized) {
        return null;
    }
    const prCacheKey = `${repoPath}::${normalized}`;
    const prEntry = state.prCache[prCacheKey];
    if (!prEntry?.data) {
        return null;
    }
    const nextStatus = deriveCheckStatusFromChecks(checks);
    if (prEntry.data.checksStatus === nextStatus) {
        return null;
    }
    return {
        prCache: {
            ...state.prCache,
            [prCacheKey]: {
                ...prEntry,
                data: {
                    ...prEntry.data,
                    checksStatus: nextStatus
                }
            }
        }
    };
}
