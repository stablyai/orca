import { MARINE_CREATURES } from '@/constants/marine-creatures';
import { basename } from '@/lib/path';
export function getSuggestedCreatureName(repoId, worktreesByRepo, nestWorkspaces) {
    if (!repoId) {
        return MARINE_CREATURES[0];
    }
    const usedNames = new Set();
    const relevantWorktrees = nestWorkspaces
        ? [worktreesByRepo[repoId] ?? []]
        : Object.values(worktreesByRepo);
    for (const worktrees of relevantWorktrees) {
        for (const worktree of worktrees) {
            usedNames.add(normalizeSuggestedName(basename(worktree.path)));
        }
    }
    for (const candidate of MARINE_CREATURES) {
        if (!usedNames.has(normalizeSuggestedName(candidate))) {
            return candidate;
        }
    }
    let suffix = 2;
    while (true) {
        for (const candidate of MARINE_CREATURES) {
            const numberedCandidate = `${candidate}-${suffix}`;
            if (!usedNames.has(normalizeSuggestedName(numberedCandidate))) {
                return numberedCandidate;
            }
        }
        suffix += 1;
    }
}
export function shouldApplySuggestedName(name, previousSuggestedName) {
    return !name.trim() || name === previousSuggestedName;
}
export function normalizeSuggestedName(name) {
    return name.trim().toLowerCase();
}
