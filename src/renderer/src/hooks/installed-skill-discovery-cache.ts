import type { SkillDiscoveryResult } from '../../../shared/skills'

export const MAX_CACHED_SKILL_DISCOVERY_TARGETS = 32
export const MAX_PENDING_SKILL_DISCOVERY_TARGETS = 16

export class InstalledSkillDiscoveryCache {
  private entries = new Map<string, SkillDiscoveryResult>()

  get(key: string): SkillDiscoveryResult | undefined {
    const cached = this.entries.get(key)
    if (cached) {
      this.entries.delete(key)
      this.entries.set(key, cached)
    }
    return cached
  }

  set(key: string, result: SkillDiscoveryResult): void {
    this.entries.delete(key)
    this.entries.set(key, result)
    while (this.entries.size > MAX_CACHED_SKILL_DISCOVERY_TARGETS) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) {
        break
      }
      this.entries.delete(oldestKey)
    }
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
