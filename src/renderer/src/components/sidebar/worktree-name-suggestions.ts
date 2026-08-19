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

// Why: dedup across every repo, not just the active one — branch names appear
// flat in the sidebar, so per-repo scoping let two repos collide on one name.
function collectUsedNames(worktreesByRepo: Record<string, WorktreePathLike[]>): Set<string> {
  const usedNames = new Set<string>()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      // Shared basename, not `@/lib/path`'s: mobile keys collisions the same way, and two copies of
      // the key could drift into suggesting a name that is in fact taken.
      usedNames.add(normalizeSuggestedName(suggestionPathBasename(worktree.path)))
    }
  }
  return usedNames
}

/** `retired` holds names already spent in the active repo, including ones whose workspace was
 *  deleted. Reissuing one would place the new workspace on the prior occupant's path, where agent
 *  CLIs would hand it that workspace's conversation history — so spent names are never offered
 *  again, and the pool degrades to suffixed variants instead of recycling.
 *
 *  Its `exhaustedTiers` watermark stands in for the tiers the registry has compacted away; those
 *  names are absent from `names` because they are all spent, not because they are available.
 *
 *  Live dedup stays cross-repo while retirement is per-repo: two live workspaces sharing a name
 *  are confusing in a flat sidebar, but a name retired under one repo says nothing about the same
 *  name under another, whose path never collided. */
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
