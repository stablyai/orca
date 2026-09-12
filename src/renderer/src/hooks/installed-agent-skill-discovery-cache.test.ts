import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillDiscoveryResult } from '../../../shared/skills'
import {
  clearInstalledAgentSkillDiscoveryCache,
  getInstalledAgentSkillDiscoveryCacheSizeForTests,
  hasInstalledAgentSkillDiscoveryCacheEntryForTests,
  INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX,
  INSTALLED_AGENT_SKILL_DISCOVERY_FRESH_MS,
  peekInstalledAgentSkillDiscoveryCache,
  readInstalledAgentSkillDiscoveryCache,
  resetInstalledAgentSkillDiscoveryCacheForTests,
  writeInstalledAgentSkillDiscoveryCache
} from './installed-agent-skill-discovery-cache'

function result(scannedAt: number): SkillDiscoveryResult {
  return { skills: [], sources: [], scannedAt }
}

afterEach(() => {
  resetInstalledAgentSkillDiscoveryCacheForTests()
  vi.restoreAllMocks()
})

describe('installed agent skill discovery cache', () => {
  it('stays bounded through prolonged churn and refreshes LRU recency on read', () => {
    for (let index = 0; index < INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX; index += 1) {
      writeInstalledAgentSkillDiscoveryCache(`target-${index}`, result(index))
    }

    expect(readInstalledAgentSkillDiscoveryCache('target-0')).toEqual(result(0))
    writeInstalledAgentSkillDiscoveryCache(
      `target-${INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX}`,
      result(INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX)
    )
    expect(hasInstalledAgentSkillDiscoveryCacheEntryForTests('target-0')).toBe(true)
    expect(hasInstalledAgentSkillDiscoveryCacheEntryForTests('target-1')).toBe(false)

    for (let index = INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX + 1; index < 10_000; index += 1) {
      writeInstalledAgentSkillDiscoveryCache(`target-${index}`, result(index))
    }

    expect(getInstalledAgentSkillDiscoveryCacheSizeForTests()).toBe(
      INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX
    )
    expect(hasInstalledAgentSkillDiscoveryCacheEntryForTests('target-9999')).toBe(true)
    expect(
      hasInstalledAgentSkillDiscoveryCacheEntryForTests(
        `target-${9999 - INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX}`
      )
    ).toBe(false)
  })

  it('rewrites an existing key in place without growing the cache', () => {
    writeInstalledAgentSkillDiscoveryCache('target', result(1))
    writeInstalledAgentSkillDiscoveryCache('target', result(2))

    expect(getInstalledAgentSkillDiscoveryCacheSizeForTests()).toBe(1)
    expect(peekInstalledAgentSkillDiscoveryCache('target')).toEqual(result(2))
  })

  it('promotes a rewritten key to most-recent so a rescanned target is not evicted first', () => {
    // Why: Map.set on an existing key keeps its original insertion order, so a
    // target rescanned on every focus event would still evict ahead of colder ones.
    writeInstalledAgentSkillDiscoveryCache('hot', result(0))
    for (let index = 1; index < INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX; index += 1) {
      writeInstalledAgentSkillDiscoveryCache(`target-${index}`, result(index))
    }

    writeInstalledAgentSkillDiscoveryCache('hot', result(1))
    writeInstalledAgentSkillDiscoveryCache('overflow', result(-1))

    expect(hasInstalledAgentSkillDiscoveryCacheEntryForTests('hot')).toBe(true)
    expect(hasInstalledAgentSkillDiscoveryCacheEntryForTests('target-1')).toBe(false)
  })

  it('peeks without reordering recency so a render pass cannot evict the wrong entry', () => {
    for (let index = 0; index < INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX; index += 1) {
      writeInstalledAgentSkillDiscoveryCache(`target-${index}`, result(index))
    }

    expect(peekInstalledAgentSkillDiscoveryCache('target-0')).toEqual(result(0))
    writeInstalledAgentSkillDiscoveryCache('overflow', result(-1))

    expect(hasInstalledAgentSkillDiscoveryCacheEntryForTests('target-0')).toBe(false)
  })

  it('clears every retained result', () => {
    writeInstalledAgentSkillDiscoveryCache('target', result(1))
    clearInstalledAgentSkillDiscoveryCache()

    expect(getInstalledAgentSkillDiscoveryCacheSizeForTests()).toBe(0)
    expect(peekInstalledAgentSkillDiscoveryCache('target')).toBeNull()
  })

  it('stops serving a read once the freshness window lapses', () => {
    const startedAt = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
    writeInstalledAgentSkillDiscoveryCache('target', result(1))

    nowSpy.mockReturnValue(startedAt + INSTALLED_AGENT_SKILL_DISCOVERY_FRESH_MS - 1)
    expect(readInstalledAgentSkillDiscoveryCache('target')).toEqual(result(1))

    nowSpy.mockReturnValue(startedAt + INSTALLED_AGENT_SKILL_DISCOVERY_FRESH_MS)
    expect(readInstalledAgentSkillDiscoveryCache('target')).toBeNull()
    expect(getInstalledAgentSkillDiscoveryCacheSizeForTests()).toBe(0)
  })

  it('still peeks a lapsed result so a first render shows the last known state', () => {
    const startedAt = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
    writeInstalledAgentSkillDiscoveryCache('target', result(1))

    nowSpy.mockReturnValue(startedAt + INSTALLED_AGENT_SKILL_DISCOVERY_FRESH_MS + 1)

    // A lapsed entry triggers a rescan; showing it beats flashing empty meanwhile.
    expect(peekInstalledAgentSkillDiscoveryCache('target')).toEqual(result(1))
  })
})
