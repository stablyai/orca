import type { SkillDiscoveryResult } from '../../../shared/skills'

// Why: project and runtime identity change across a long renderer session, so the
// keyed results accumulate; keep the most recent targets instead of every target
// the window has ever resolved.
export const INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX = 256

// Why: focus-triggered refreshes read through this cache instead of forcing a
// disk walk, so it needs a lifetime — without one a non-forced read would never
// see a skill installed outside Orca. Matches the focus-rescan cooldown the
// freshness inventory already applies to its own scan (`useSkillFreshness`), so
// the two disk-reading surfaces answer a burst of alt-tabs the same way.
export const INSTALLED_AGENT_SKILL_DISCOVERY_FRESH_MS = 15_000

type CachedDiscovery = { result: SkillDiscoveryResult; expiresAt: number }

let cachedDiscoveryByTarget = new Map<string, CachedDiscovery>()

function readUnexpired(key: string): CachedDiscovery | null {
  const cached = cachedDiscoveryByTarget.get(key)
  if (!cached) {
    return null
  }
  if (cached.expiresAt <= Date.now()) {
    cachedDiscoveryByTarget.delete(key)
    return null
  }
  return cached
}

// Why: render reads must not reorder recency — React can discard a render pass.
export function peekInstalledAgentSkillDiscoveryCache(key: string): SkillDiscoveryResult | null {
  // Why: an expired entry is still the last thing this window knew, and showing it
  // beats flashing empty while the refresh it triggers is in flight.
  return cachedDiscoveryByTarget.get(key)?.result ?? null
}

export function readInstalledAgentSkillDiscoveryCache(key: string): SkillDiscoveryResult | null {
  const cached = readUnexpired(key)
  if (!cached) {
    return null
  }
  cachedDiscoveryByTarget.delete(key)
  cachedDiscoveryByTarget.set(key, cached)
  return cached.result
}

export function writeInstalledAgentSkillDiscoveryCache(
  key: string,
  result: SkillDiscoveryResult
): void {
  cachedDiscoveryByTarget.delete(key)
  cachedDiscoveryByTarget.set(key, {
    result,
    expiresAt: Date.now() + INSTALLED_AGENT_SKILL_DISCOVERY_FRESH_MS
  })
  while (cachedDiscoveryByTarget.size > INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX) {
    const oldestKey = cachedDiscoveryByTarget.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    cachedDiscoveryByTarget.delete(oldestKey)
  }
}

export function clearInstalledAgentSkillDiscoveryCache(): void {
  cachedDiscoveryByTarget.clear()
}

export function getInstalledAgentSkillDiscoveryCacheSizeForTests(): number {
  return cachedDiscoveryByTarget.size
}

export function hasInstalledAgentSkillDiscoveryCacheEntryForTests(key: string): boolean {
  return cachedDiscoveryByTarget.has(key)
}

export function resetInstalledAgentSkillDiscoveryCacheForTests(): void {
  cachedDiscoveryByTarget = new Map()
}
