import { MARINE_CREATURES } from './marine-creatures'
import {
  clampExhaustedTiers,
  creatureNameAtTier,
  EMPTY_RETIRED_NAME_REGISTRY,
  type RetiredNameRegistry
} from './worktree/retired-name-registry'

/** Desktop and mobile share selection rules; callers supply live/retired names from their own stores. */

export function normalizeSuggestedName(name: string): string {
  return name.trim().toLowerCase()
}

function stripTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

/** Compare directory basenames across POSIX, Windows and SSH paths; display names do not determine collisions. */
export function suggestionPathBasename(path: string): string {
  const normalized = stripTrailingSeparators(path)
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return index === -1 ? normalized : normalized.slice(index + 1)
}

function pickRandom<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]
}

/** Randomize unused names, then advance through suffix tiers. Include retired names: reusing a deleted workspace’s cwd can expose its agent conversation history.
 * Skip exhaustedTiers outright; compaction removed their individually listed names because they are all spent. */
export function selectSuggestedCreatureName(
  usedNames: Iterable<string>,
  random: () => number = Math.random,
  exhaustedTiers = 0
): string {
  const used = new Set<string>()
  for (const name of usedNames) {
    used.add(normalizeSuggestedName(name))
  }

  let tier = clampExhaustedTiers(exhaustedTiers) + 1
  while (true) {
    const available = MARINE_CREATURES.map((name) =>
      creatureNameAtTier(normalizeSuggestedName(name), tier)
    ).filter((name) => !used.has(name))
    if (available.length > 0) {
      return pickRandom(available, random)
    }
    tier += 1
  }
}

/** Collisions use the on-disk basename, not displayName. Retired names may retain conversation state keyed by cwd; exhaustedTiers covers compacted names a host no longer lists. */
export function suggestCreatureNameForPaths(
  existingPaths: readonly string[],
  random: () => number = Math.random,
  retired: RetiredNameRegistry = EMPTY_RETIRED_NAME_REGISTRY
): string {
  const used = new Set<string>()
  for (const path of existingPaths) {
    used.add(normalizeSuggestedName(suggestionPathBasename(path)))
  }
  for (const retiredName of retired.names) {
    used.add(normalizeSuggestedName(retiredName))
  }
  return selectSuggestedCreatureName(used, random, retired.exhaustedTiers)
}
