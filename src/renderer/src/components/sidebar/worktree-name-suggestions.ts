import {
  normalizeSuggestedName,
  selectSuggestedCreatureName,
  suggestionPathBasename
} from '../../../../shared/worktree-name-suggestion'
import {
  EMPTY_RETIRED_NAME_REGISTRY,
  type RetiredNameRegistry
} from '../../../../shared/worktree/retired-name-registry'

type WorktreePathLike = {
  path: string
}

// Deduplicate live names across repos because the sidebar presents them together.
function collectUsedNames(worktreesByRepo: Record<string, WorktreePathLike[]>): Set<string> {
  const usedNames = new Set<string>()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      // Share mobile’s basename normalization so both clients agree which names are taken.
      usedNames.add(normalizeSuggestedName(suggestionPathBasename(worktree.path)))
    }
  }
  return usedNames
}

/** Retire names per repo to prevent path/chat-history reuse; exhaustedTiers marks compacted spent tiers, while live dedup stays cross-repo. */
export function getSuggestedCreatureName(
  worktreesByRepo: Record<string, WorktreePathLike[]>,
  random: () => number = Math.random,
  retired: RetiredNameRegistry = EMPTY_RETIRED_NAME_REGISTRY
): string {
  const usedNames = collectUsedNames(worktreesByRepo)
  for (const retiredName of retired.names) {
    usedNames.add(normalizeSuggestedName(retiredName))
  }
  return selectSuggestedCreatureName(usedNames, random, retired.exhaustedTiers)
}

export function shouldApplySuggestedName(name: string, previousSuggestedName: string): boolean {
  return !name.trim() || name === previousSuggestedName
}

export { normalizeSuggestedName }
