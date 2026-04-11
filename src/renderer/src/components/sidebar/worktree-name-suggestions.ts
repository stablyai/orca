import { FISH_NAMES } from '@/constants/fish-names'
import { basename } from '@/lib/path'

type WorktreePathLike = {
  path: string
}

export function getSuggestedFishName(
  repoId: string,
  worktreesByRepo: Record<string, WorktreePathLike[]>,
  nestWorkspaces: boolean
): string {
  if (!repoId) {
    return FISH_NAMES[0]
  }

  const usedNames = new Set<string>()
  const relevantWorktrees = nestWorkspaces
    ? [worktreesByRepo[repoId] ?? []]
    : Object.values(worktreesByRepo)

  for (const worktrees of relevantWorktrees) {
    for (const worktree of worktrees) {
      usedNames.add(normalizeSuggestedName(basename(worktree.path)))
    }
  }

  for (const candidate of FISH_NAMES) {
    if (!usedNames.has(normalizeSuggestedName(candidate))) {
      return candidate
    }
  }

  let suffix = 2
  while (true) {
    for (const candidate of FISH_NAMES) {
      const numberedCandidate = `${candidate}-${suffix}`
      if (!usedNames.has(normalizeSuggestedName(numberedCandidate))) {
        return numberedCandidate
      }
    }
    suffix += 1
  }
}

export function shouldApplySuggestedName(name: string, previousSuggestedName: string): boolean {
  return !name.trim() || name === previousSuggestedName
}

export function normalizeSuggestedName(name: string): string {
  return name.trim().toLowerCase()
}
