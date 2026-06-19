import { MARINE_CREATURES } from '@/constants/marine-creatures'
import { basename } from '@/lib/path'

type WorktreePathLike = {
  path: string
}

// Why: dedup across every repo, not just the active one — branch names appear
// flat in the sidebar, so per-repo scoping let two repos collide on one name.
function collectUsedNames(worktreesByRepo: Record<string, WorktreePathLike[]>): Set<string> {
  const usedNames = new Set<string>()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      usedNames.add(normalizeSuggestedName(basename(worktree.path)))
    }
  }
  return usedNames
}

function pickRandom<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]
}

export function getSuggestedCreatureName(
  worktreesByRepo: Record<string, WorktreePathLike[]>,
  random: () => number = Math.random
): string {
  const usedNames = collectUsedNames(worktreesByRepo)

  // Why: names are lowercased (branch names are conventionally lowercase, e.g.
  // fix/seahorse), and a random pick keeps fresh worktrees from all starting at
  // the same creature and marching down the list in lockstep.
  const available = MARINE_CREATURES.map(normalizeSuggestedName).filter(
    (name) => !usedNames.has(name)
  )
  if (available.length > 0) {
    return pickRandom(available, random)
  }

  // Every base name is taken — fall back to numbered variants.
  let suffix = 2
  while (true) {
    const numbered = MARINE_CREATURES.map(
      (name) => `${normalizeSuggestedName(name)}-${suffix}`
    ).filter((name) => !usedNames.has(name))
    if (numbered.length > 0) {
      return pickRandom(numbered, random)
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
