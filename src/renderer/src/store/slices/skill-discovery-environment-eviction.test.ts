import { afterEach, describe, expect, it } from 'vitest'
import { create } from 'zustand'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { SkillDiscoveryResult } from '../../../../shared/skills'
import {
  getRuntimeScopedSkillDiscoveryKey,
  resetSkillDiscoveryCacheForTests
} from '@/hooks/installed-agent-skill-discovery'
import {
  getInstalledAgentSkillDiscoveryCacheSizeForTests,
  hasInstalledAgentSkillDiscoveryCacheEntryForTests,
  writeInstalledAgentSkillDiscoveryCache
} from '@/hooks/installed-agent-skill-discovery-cache'
import { createRuntimeStatusSlice, type RuntimeStatusSlice } from './runtime-status'

function createSliceStore() {
  return create<RuntimeStatusSlice>()((...a) => ({
    ...createRuntimeStatusSlice(...(a as unknown as Parameters<typeof createRuntimeStatusSlice>))
  }))
}

function env(id: string, pairingRevision = 1): PublicKnownRuntimeEnvironment {
  return { id, createdAt: 1, pairingRevision } as unknown as PublicKnownRuntimeEnvironment
}

function discovery(scannedAt: number): SkillDiscoveryResult {
  return { skills: [], sources: [], scannedAt }
}

function runtimeKey(environmentId: string): string {
  return getRuntimeScopedSkillDiscoveryKey({ kind: 'environment', environmentId }, undefined)
}

afterEach(() => {
  resetSkillDiscoveryCacheForTests()
})

describe('skill discovery cache evicted on environment removal (#11429)', () => {
  it("evicts a removed environment's runtime-scoped entry and keeps survivors", () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironments([env('env-keep'), env('env-drop')])
    writeInstalledAgentSkillDiscoveryCache(runtimeKey('env-keep'), discovery(1))
    writeInstalledAgentSkillDiscoveryCache(runtimeKey('env-drop'), discovery(2))
    writeInstalledAgentSkillDiscoveryCache('host', discovery(3))

    store.getState().setRuntimeEnvironments([env('env-keep')])

    expect(hasInstalledAgentSkillDiscoveryCacheEntryForTests(runtimeKey('env-drop'))).toBe(false)
    expect(hasInstalledAgentSkillDiscoveryCacheEntryForTests(runtimeKey('env-keep'))).toBe(true)
    expect(hasInstalledAgentSkillDiscoveryCacheEntryForTests('host')).toBe(true)
  })

  it("evicts on same-id re-pair so the retired peer's skill list is not served", () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironments([env('env-a', 1)])
    writeInstalledAgentSkillDiscoveryCache(runtimeKey('env-a'), discovery(1))

    store.getState().setRuntimeEnvironments([env('env-a', 2)])

    expect(hasInstalledAgentSkillDiscoveryCacheEntryForTests(runtimeKey('env-a'))).toBe(false)
  })

  it('returns to baseline across repeated ephemeral runtime cycles', () => {
    const store = createSliceStore()
    const keep = env('env-keep')
    store.getState().setRuntimeEnvironments([keep])
    writeInstalledAgentSkillDiscoveryCache(runtimeKey(keep.id), discovery(1))
    writeInstalledAgentSkillDiscoveryCache('host', discovery(2))
    const baseline = getInstalledAgentSkillDiscoveryCacheSizeForTests()

    for (let cycle = 0; cycle < 100; cycle += 1) {
      const ephemeral = env(`orca-${cycle}`)
      store.getState().setRuntimeEnvironments([keep, ephemeral])
      writeInstalledAgentSkillDiscoveryCache(runtimeKey(ephemeral.id), discovery(cycle + 3))
      expect(getInstalledAgentSkillDiscoveryCacheSizeForTests()).toBe(baseline + 1)

      store.getState().setRuntimeEnvironments([keep])
      expect(getInstalledAgentSkillDiscoveryCacheSizeForTests()).toBe(baseline)
    }

    expect(hasInstalledAgentSkillDiscoveryCacheEntryForTests(runtimeKey(keep.id))).toBe(true)
    expect(hasInstalledAgentSkillDiscoveryCacheEntryForTests('host')).toBe(true)
  })
})
