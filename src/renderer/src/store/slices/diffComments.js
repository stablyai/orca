import { findWorktreeById, getRepoIdFromWorktreeId } from './worktree-helpers';
function generateId() {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
async function persist(worktreeId, diffComments) {
    await window.api.worktrees.updateMeta({
        worktreeId,
        updates: { diffComments }
    });
}
// Why: derive the next comment list from the latest store snapshot inside
// the `set` updater so two concurrent writes (rapid add+delete, or a
// delete-while-add-in-flight) can't clobber each other via a stale closure.
function mutateComments(set, worktreeId, mutate) {
    const repoId = getRepoIdFromWorktreeId(worktreeId);
    let previous;
    let next = null;
    set((s) => {
        const repoList = s.worktreesByRepo[repoId];
        if (!repoList) {
            return {};
        }
        const target = repoList.find((w) => w.id === worktreeId);
        if (!target) {
            return {};
        }
        previous = target.diffComments;
        const computed = mutate(previous ?? []);
        if (computed === null) {
            return {};
        }
        next = computed;
        const nextList = repoList.map((w) => w.id === worktreeId ? { ...w, diffComments: computed } : w);
        return { worktreesByRepo: { ...s.worktreesByRepo, [repoId]: nextList } };
    });
    if (next === null) {
        return null;
    }
    return { previous, next };
}
// Why: if the IPC write fails, the optimistic renderer state drifts from
// disk. Roll back so what the user sees always matches what will survive a
// reload.
function rollback(set, worktreeId, previous) {
    const repoId = getRepoIdFromWorktreeId(worktreeId);
    set((s) => {
        const repoList = s.worktreesByRepo[repoId];
        if (!repoList) {
            return {};
        }
        const nextList = repoList.map((w) => w.id === worktreeId ? { ...w, diffComments: previous } : w);
        return { worktreesByRepo: { ...s.worktreesByRepo, [repoId]: nextList } };
    });
}
export const createDiffCommentsSlice = (set, get) => ({
    getDiffComments: (worktreeId, filePath) => {
        const worktree = findWorktreeById(get().worktreesByRepo, worktreeId);
        const all = worktree?.diffComments ?? [];
        if (!filePath) {
            return all;
        }
        return all.filter((c) => c.filePath === filePath);
    },
    addDiffComment: async (input) => {
        const comment = {
            ...input,
            id: generateId(),
            createdAt: Date.now()
        };
        const result = mutateComments(set, input.worktreeId, (existing) => [
            ...existing,
            comment
        ]);
        if (!result) {
            return null;
        }
        try {
            await persist(input.worktreeId, result.next);
            return comment;
        }
        catch (err) {
            console.error('Failed to persist diff comments:', err);
            rollback(set, input.worktreeId, result.previous);
            return null;
        }
    },
    deleteDiffComment: async (worktreeId, commentId) => {
        const result = mutateComments(set, worktreeId, (existing) => {
            const next = existing.filter((c) => c.id !== commentId);
            return next.length === existing.length ? null : next;
        });
        if (!result) {
            return;
        }
        try {
            await persist(worktreeId, result.next);
        }
        catch (err) {
            console.error('Failed to persist diff comments:', err);
            rollback(set, worktreeId, result.previous);
        }
    },
    clearDiffComments: async (worktreeId) => {
        const result = mutateComments(set, worktreeId, (existing) => existing.length === 0 ? null : []);
        if (!result) {
            return;
        }
        try {
            await persist(worktreeId, result.next);
        }
        catch (err) {
            console.error('Failed to persist diff comments:', err);
            rollback(set, worktreeId, result.previous);
        }
    }
});
