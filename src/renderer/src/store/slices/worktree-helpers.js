export function findWorktreeById(worktreesByRepo, worktreeId) {
    for (const worktrees of Object.values(worktreesByRepo)) {
        const match = worktrees.find((worktree) => worktree.id === worktreeId);
        if (match) {
            return match;
        }
    }
    return undefined;
}
export function applyWorktreeUpdates(worktreesByRepo, worktreeId, updates) {
    let changed = false;
    const next = {};
    for (const [repoId, worktrees] of Object.entries(worktreesByRepo)) {
        let repoChanged = false;
        const nextWorktrees = worktrees.map((worktree) => {
            if (worktree.id !== worktreeId) {
                return worktree;
            }
            const updatedWorktree = { ...worktree, ...updates };
            repoChanged = true;
            changed = true;
            return updatedWorktree;
        });
        next[repoId] = repoChanged ? nextWorktrees : worktrees;
    }
    return changed ? next : worktreesByRepo;
}
export function getRepoIdFromWorktreeId(worktreeId) {
    const sepIdx = worktreeId.indexOf('::');
    return sepIdx === -1 ? worktreeId : worktreeId.slice(0, sepIdx);
}
