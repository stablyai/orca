import type { SkillDiscoveryResult } from '../../../../shared/skills'

const PANE_DISCOVERY_CACHE_LIMIT = 8

export function readPaneDiscoveryCache(
  cache: Map<string, SkillDiscoveryResult>,
  key: string
): SkillDiscoveryResult | undefined {
  const result = cache.get(key)
  if (result) {
    cache.delete(key)
    cache.set(key, result)
  }
  return result
}

export function writePaneDiscoveryCache(
  cache: Map<string, SkillDiscoveryResult>,
  key: string,
  result: SkillDiscoveryResult
): void {
  cache.delete(key)
  cache.set(key, result)
  while (cache.size > PANE_DISCOVERY_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    cache.delete(oldestKey)
  }
}
