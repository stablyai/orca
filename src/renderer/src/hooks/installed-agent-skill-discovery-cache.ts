import type { SkillDiscoveryResult } from '../../../shared/skills'

// Why: project and runtime identity change across a long renderer session, so the
// keyed results accumulate; keep the most recent targets instead of every target
// the window has ever resolved.
export const INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX = 256

let cachedDiscoveryByTarget = new Map<string, SkillDiscoveryResult>()

// Why: render reads must not reorder recency — React can discard a render pass.
export function peekInstalledAgentSkillDiscoveryCache(key: string): SkillDiscoveryResult | null {
  return cachedDiscoveryByTarget.get(key) ?? null
}

export function readInstalledAgentSkillDiscoveryCache(key: string): SkillDiscoveryResult | null {
  const result = cachedDiscoveryByTarget.get(key)
  if (!result) {
    return null
  }
  cachedDiscoveryByTarget.delete(key)
  cachedDiscoveryByTarget.set(key, result)
  return result
}

export function writeInstalledAgentSkillDiscoveryCache(
  key: string,
  result: SkillDiscoveryResult
): void {
  cachedDiscoveryByTarget.delete(key)
  cachedDiscoveryByTarget.set(key, result)
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
