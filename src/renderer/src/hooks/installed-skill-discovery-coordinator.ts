import type { SkillDiscoveryResult } from '../../../shared/skills'
import {
  InstalledSkillDiscoveryCache,
  MAX_PENDING_SKILL_DISCOVERY_TARGETS
} from './installed-skill-discovery-cache'

export class InstalledSkillDiscoveryCoordinator {
  private readonly cache = new InstalledSkillDiscoveryCache()
  private readonly pending = new Map<string, Promise<SkillDiscoveryResult>>()
  private readonly pendingSatisfiesForcedRefresh = new Map<string, boolean>()
  private cacheGeneration = 0

  getCached(key: string): SkillDiscoveryResult | undefined {
    return this.cache.get(key)
  }

  clearCache(): void {
    this.cacheGeneration += 1
    this.cache.clear()
  }

  sizes(): { cached: number; pending: number } {
    return { cached: this.cache.size, pending: this.pending.size }
  }

  async discover({
    force,
    key,
    run
  }: {
    force: boolean
    key: string
    run: () => Promise<SkillDiscoveryResult>
  }): Promise<SkillDiscoveryResult> {
    const cached = this.cache.get(key)
    if (!force && cached) {
      return cached
    }
    const inFlight = this.pending.get(key)
    if (inFlight) {
      if (!force || this.pendingSatisfiesForcedRefresh.get(key)) {
        return inFlight
      }
      try {
        await inFlight
      } catch {
        // Why: an explicit re-check still needs current disk state after a background failure.
      }
      const replacement = this.pending.get(key)
      if (replacement && replacement !== inFlight) {
        return replacement
      }
    }
    return this.start(force, key, run)
  }

  private start(
    force: boolean,
    key: string,
    run: () => Promise<SkillDiscoveryResult>
  ): Promise<SkillDiscoveryResult> {
    if (!this.pending.has(key) && this.pending.size >= MAX_PENDING_SKILL_DISCOVERY_TARGETS) {
      return Promise.reject(
        new Error(
          `Too many concurrent installed-skill discovery targets (max ${MAX_PENDING_SKILL_DISCOVERY_TARGETS})`
        )
      )
    }
    const cacheGeneration = this.cacheGeneration
    const discovery = run()
      .then((result) => {
        if (cacheGeneration === this.cacheGeneration) {
          this.cache.set(key, result)
        }
        return result
      })
      .finally(() => {
        if (this.pending.get(key) === discovery) {
          this.pending.delete(key)
          this.pendingSatisfiesForcedRefresh.delete(key)
        }
      })
    this.pending.set(key, discovery)
    this.pendingSatisfiesForcedRefresh.set(key, force)
    return discovery
  }
}
