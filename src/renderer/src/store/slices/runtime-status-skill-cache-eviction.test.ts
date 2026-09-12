import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { SkillDiscoveryResult } from '../../../../shared/skills'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

const discoverSkillsForRuntimeTarget = vi.hoisted(() =>
  vi.fn<(runtimeTarget: RuntimeClientTarget) => Promise<SkillDiscoveryResult>>()
)

vi.mock('@/runtime/runtime-skills-client', () => ({ discoverSkillsForRuntimeTarget }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: {} }

import {
  discoverInstalledAgentSkills,
  getCachedSkillDiscovery,
  resetSkillDiscoveryCacheForTests
} from '@/hooks/installed-agent-skill-discovery'
import { getInstalledAgentSkillDiscoveryCacheSizeForTests } from '@/hooks/installed-agent-skill-discovery-cache'
import { createTestStore } from './store-test-helpers'

function environment(id: string, pairingRevision = 1): PublicKnownRuntimeEnvironment {
  return { id, createdAt: 1, pairingRevision } as PublicKnownRuntimeEnvironment
}

function remote(environmentId: string): RuntimeClientTarget {
  return { kind: 'environment', environmentId }
}

function result(scannedAt: number): SkillDiscoveryResult {
  return { skills: [], sources: [], scannedAt }
}

function deferred(): {
  promise: Promise<SkillDiscoveryResult>
  resolve: (value: SkillDiscoveryResult) => void
} {
  let resolve!: (value: SkillDiscoveryResult) => void
  const promise = new Promise<SkillDiscoveryResult>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

afterEach(() => {
  resetSkillDiscoveryCacheForTests()
  discoverSkillsForRuntimeTarget.mockReset()
})

describe('runtime environment skill-cache eviction', () => {
  it('releases retired runtime entries while preserving local and WSL cached scans', async () => {
    const store = createTestStore()
    discoverSkillsForRuntimeTarget.mockResolvedValue(result(1))
    await discoverInstalledAgentSkills(false)
    await discoverInstalledAgentSkills(false, { runtime: 'wsl', wslDistro: 'Ubuntu' })
    for (let index = 0; index < 512; index++) {
      const id = `temporary-${index}`
      store.getState().setRuntimeEnvironments([environment(id)])
      await discoverInstalledAgentSkills(false, undefined, remote(id))
      store.getState().setRuntimeEnvironments([])
    }

    expect(getInstalledAgentSkillDiscoveryCacheSizeForTests()).toBe(2)
    expect(getCachedSkillDiscovery('host')).toEqual(result(1))
    expect(getCachedSkillDiscovery('wsl:Ubuntu')).toEqual(result(1))
    expect(discoverSkillsForRuntimeTarget).toHaveBeenCalledTimes(514)
  })

  it('keeps a surviving runtime scan in flight when another runtime is removed', async () => {
    const store = createTestStore()
    const survivor = deferred()
    store.getState().setRuntimeEnvironments([environment('a'), environment('b')])
    discoverSkillsForRuntimeTarget.mockReturnValue(survivor.promise)
    const first = discoverInstalledAgentSkills(false, undefined, remote('b'))

    store.getState().setRuntimeEnvironments([environment('b')])
    const joined = discoverInstalledAgentSkills(false, undefined, remote('b'))
    expect(discoverSkillsForRuntimeTarget).toHaveBeenCalledOnce()
    survivor.resolve(result(2))

    await expect(Promise.all([first, joined])).resolves.toEqual([result(2), result(2)])
  })

  it.each(['before', 'after'] as const)(
    'a retired scan finishing %s its replacement cannot overwrite it or detach its pending slot',
    async (order) => {
      const store = createTestStore()
      const stale = deferred()
      const current = deferred()
      store.getState().setRuntimeEnvironments([environment('a')])
      discoverSkillsForRuntimeTarget
        .mockReturnValueOnce(stale.promise)
        .mockReturnValueOnce(current.promise)
      const oldRequest = discoverInstalledAgentSkills(false, undefined, remote('a'))
      store.getState().setRuntimeEnvironments([environment('a', 2)])
      const newRequest = discoverInstalledAgentSkills(true, undefined, remote('a'))
      if (order === 'after') {
        current.resolve(result(2))
        await newRequest
      }
      stale.resolve(result(1))
      await oldRequest
      const joined = discoverInstalledAgentSkills(false, undefined, remote('a'))
      expect(discoverSkillsForRuntimeTarget).toHaveBeenCalledTimes(2)
      current.resolve(result(2))

      await expect(Promise.all([newRequest, joined])).resolves.toEqual([result(2), result(2)])
      expect(getCachedSkillDiscovery('runtime:a')).toEqual(result(2))
    }
  )

  it('rescans only the removed runtime environment', async () => {
    const store = createTestStore()
    store.getState().setRuntimeEnvironments([environment('env-a'), environment('env-b')])
    discoverSkillsForRuntimeTarget
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(2))
      .mockResolvedValueOnce(result(3))

    await discoverInstalledAgentSkills(false, undefined, remote('env-a'))
    await discoverInstalledAgentSkills(false, undefined, remote('env-b'))
    store.getState().setRuntimeEnvironments([environment('env-b')])

    await expect(discoverInstalledAgentSkills(false, undefined, remote('env-a'))).resolves.toEqual(
      result(3)
    )
    await expect(discoverInstalledAgentSkills(false, undefined, remote('env-b'))).resolves.toEqual(
      result(2)
    )
    expect(discoverSkillsForRuntimeTarget).toHaveBeenCalledTimes(3)
  })

  it('evicts a re-paired runtime without churning an unchanged runtime', async () => {
    const store = createTestStore()
    store.getState().setRuntimeEnvironments([environment('env-a')])
    discoverSkillsForRuntimeTarget.mockResolvedValueOnce(result(1)).mockResolvedValueOnce(result(2))

    await discoverInstalledAgentSkills(false, undefined, remote('env-a'))
    store.getState().setRuntimeEnvironments([environment('env-a')])
    await expect(discoverInstalledAgentSkills(false, undefined, remote('env-a'))).resolves.toEqual(
      result(1)
    )

    store.getState().setRuntimeEnvironments([environment('env-a', 2)])
    await expect(discoverInstalledAgentSkills(false, undefined, remote('env-a'))).resolves.toEqual(
      result(2)
    )
    expect(discoverSkillsForRuntimeTarget).toHaveBeenCalledTimes(2)
  })

  it('does not let an in-flight scan restore a removed runtime cache entry', async () => {
    const store = createTestStore()
    const staleScan = deferred()
    const freshScan = deferred()
    store.getState().setRuntimeEnvironments([environment('env-a')])
    discoverSkillsForRuntimeTarget
      .mockReturnValueOnce(staleScan.promise)
      .mockReturnValueOnce(freshScan.promise)

    const staleRequest = discoverInstalledAgentSkills(false, undefined, remote('env-a'))
    store.getState().setRuntimeEnvironments([])
    staleScan.resolve(result(1))
    await expect(staleRequest).resolves.toEqual(result(1))

    const freshRequest = discoverInstalledAgentSkills(false, undefined, remote('env-a'))
    expect(discoverSkillsForRuntimeTarget).toHaveBeenCalledTimes(2)
    freshScan.resolve(result(2))
    await expect(freshRequest).resolves.toEqual(result(2))
  })
})
