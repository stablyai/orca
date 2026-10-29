import { MARINE_CREATURES } from '../marine-creatures'

/** Never evict retired names: their cwd may retain agent history. Compact complete consecutive pool tiers into exhaustedTiers; retain explicit names above the watermark. */
export type RetiredNameRegistry = {
  exhaustedTiers: number
  names: readonly string[]
}

export const EMPTY_RETIRED_NAME_REGISTRY: RetiredNameRegistry = { exhaustedTiers: 0, names: [] }

export const CREATURE_POOL_NAMES: ReadonlySet<string> = new Set(
  MARINE_CREATURES.map((name) => name.toLowerCase())
)

// Cap the watermark at the highest tier creatureNameTier can parse.
const MAX_EXHAUSTED_TIERS = 999_999

/** Tier 1 is the bare pool name; tier N is `name-N`. */
export function creatureNameAtTier(poolName: string, tier: number): string {
  return tier === 1 ? poolName : `${poolName}-${tier}`
}

/** Only generated pool/tier spellings can be covered by a watermark; user labels and repeat-suffixed collisions remain explicit. */
export function creatureNameTier(name: string): number | null {
  const normalized = name.trim().toLowerCase()
  if (CREATURE_POOL_NAMES.has(normalized)) {
    return 1
  }
  const match = /^(.+)-([1-9]\d{0,5})$/.exec(normalized)
  if (!match || !CREATURE_POOL_NAMES.has(match[1])) {
    return null
  }
  // `nautilus-1` is not the tier-1 name — the bare name is — so it stays explicit.
  const tier = Number(match[2])
  return tier >= 2 ? tier : null
}

export function clampExhaustedTiers(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_EXHAUSTED_TIERS)
    : 0
}

/** Build once per create attempt to avoid rebuilding the explicit set for up to 100 probes; compacted tiers need no reconstruction. */
export function createRetiredNameLookup(registry: RetiredNameRegistry): (name: string) => boolean {
  const explicit = new Set(registry.names)
  const exhaustedTiers = clampExhaustedTiers(registry.exhaustedTiers)
  return (name) => {
    const normalized = name.trim().toLowerCase()
    if (explicit.has(normalized)) {
      return true
    }
    const tier = creatureNameTier(normalized)
    return tier !== null && tier <= exhaustedTiers
  }
}

function tierIsComplete(names: ReadonlySet<string>, tier: number): boolean {
  for (const poolName of CREATURE_POOL_NAMES) {
    if (!names.has(creatureNameAtTier(poolName, tier))) {
      return false
    }
  }
  return true
}

/** Fold consecutive completed tiers into the watermark. Collisions can spend higher-tier names early; keep those explicit until intervening tiers complete. */
export function compactRetiredNames(registry: RetiredNameRegistry): RetiredNameRegistry {
  let exhaustedTiers = clampExhaustedTiers(registry.exhaustedTiers)
  const names = new Set(registry.names)
  while (exhaustedTiers < MAX_EXHAUSTED_TIERS && tierIsComplete(names, exhaustedTiers + 1)) {
    exhaustedTiers += 1
  }
  for (const name of names) {
    const tier = creatureNameTier(name)
    if (tier !== null && tier <= exhaustedTiers) {
      names.delete(name)
    }
  }
  return { exhaustedTiers, names: [...names] }
}

/** Return null for no change. Callers must enforce retirement eligibility before supplying names. */
export function addRetiredNames(
  registry: RetiredNameRegistry,
  incoming: Iterable<string>
): RetiredNameRegistry | null {
  const isRetired = createRetiredNameLookup(registry)
  const added: string[] = []
  for (const name of incoming) {
    if (!isRetired(name)) {
      added.push(name)
    }
  }
  return added.length === 0
    ? null
    : compactRetiredNames({
        exhaustedTiers: registry.exhaustedTiers,
        names: [...registry.names, ...added]
      })
}

/** Take the higher watermark so peer merges never re-expand spent tiers. */
export function mergeRetiredNameRegistries(
  base: RetiredNameRegistry,
  incoming: RetiredNameRegistry
): RetiredNameRegistry {
  return compactRetiredNames({
    exhaustedTiers: Math.max(base.exhaustedTiers, incoming.exhaustedTiers),
    names: [...base.names, ...incoming.names]
  })
}

export function isEmptyRetiredNameRegistry(registry: RetiredNameRegistry): boolean {
  return registry.exhaustedTiers === 0 && registry.names.length === 0
}
