import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../../shared/skills'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

const discoverSkillsForRuntimeTarget = vi.hoisted(() =>
  vi.fn<
    (
      runtimeTarget: RuntimeClientTarget,
      target?: SkillDiscoveryTarget
    ) => Promise<SkillDiscoveryResult>
  >()
)

vi.mock('@/runtime/runtime-skills-client', () => ({ discoverSkillsForRuntimeTarget }))

const {
  discoverInstalledAgentSkills,
  getRuntimeScopedSkillDiscoveryKey,
  getSkillDiscoveryTargetKey,
  invalidateInstalledAgentSkillDiscovery,
  resetSkillDiscoveryCacheForTests
} = await import('./installed-agent-skill-discovery')

const LOCAL: RuntimeClientTarget = { kind: 'local' }
const remote = (environmentId: string): RuntimeClientTarget => ({
  kind: 'environment',
  environmentId
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function result(scannedAt: number): SkillDiscoveryResult {
  return { skills: [], sources: [], scannedAt }
}

const resolvedWslProjectRuntime = {
  status: 'resolved' as const,
  runtime: {
    kind: 'wsl' as const,
    hostPlatform: 'wsl' as const,
    projectId: 'repo-1',
    distro: 'Ubuntu',
    reason: 'project-override' as const,
    cacheKey: 'repo-1:wsl:Ubuntu'
  }
}

const resolvedHostProjectRuntime = {
  status: 'resolved' as const,
  runtime: {
    kind: 'windows-host' as const,
    hostPlatform: 'win32' as const,
    projectId: 'repo-1',
    reason: 'project-override' as const,
    cacheKey: 'repo-1:windows-host'
  }
}

const repairProjectRuntime = {
  status: 'repair-required' as const,
  repair: {
    projectId: 'repo-1',
    preferredRuntime: { kind: 'wsl' as const, distro: null },
    reason: 'wsl-distro-required' as const,
    source: 'project-override' as const,
    cacheKey: 'repo-1:repair:wsl-distro-required:default'
  }
}

afterEach(() => {
  resetSkillDiscoveryCacheForTests()
  discoverSkillsForRuntimeTarget.mockReset()
})

describe('installed agent skill discovery lifecycle', () => {
  it('does not let a pre-install scan repopulate invalidated cache state', async () => {
    const staleScan = deferred<SkillDiscoveryResult>()
    const freshScan = deferred<SkillDiscoveryResult>()
    const discover = discoverSkillsForRuntimeTarget
    discover.mockReturnValueOnce(staleScan.promise)
    discover.mockReturnValueOnce(freshScan.promise)
    const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }

    const staleRequest = discoverInstalledAgentSkills(false, target)
    invalidateInstalledAgentSkillDiscovery()
    const freshRequest = discoverInstalledAgentSkills(false, target)
    expect(discover).toHaveBeenCalledTimes(2)

    // Settle the stale scan last so missing generation fences would overwrite the post-install result.
    freshScan.resolve(result(2))
    await expect(freshRequest).resolves.toEqual(result(2))
    staleScan.resolve(result(1))
    await expect(staleRequest).resolves.toEqual(result(1))

    await expect(discoverInstalledAgentSkills(false, target)).resolves.toEqual(result(2))
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('serves a warm cache unforced and rescans when forced', async () => {
    // Forced refresh must bypass warm cache to discover external installs.
    const discover = discoverSkillsForRuntimeTarget
    discover.mockResolvedValueOnce(result(1))
    discover.mockResolvedValueOnce(result(2))

    await expect(discoverInstalledAgentSkills(false, undefined)).resolves.toEqual(result(1))
    await expect(discoverInstalledAgentSkills(false, undefined)).resolves.toEqual(result(1))
    expect(discover).toHaveBeenCalledTimes(1)

    await expect(discoverInstalledAgentSkills(true, undefined)).resolves.toEqual(result(2))
    expect(discover).toHaveBeenCalledTimes(2)
    await expect(discoverInstalledAgentSkills(false, undefined)).resolves.toEqual(result(2))
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('releases the pending slot so later forced refreshes rescan', async () => {
    // Settle-time cleanup prevents pending-map leaks and reuse of an already-settled scan.
    const discover = discoverSkillsForRuntimeTarget
    discover.mockResolvedValueOnce(result(1))
    discover.mockResolvedValueOnce(result(2))
    discover.mockResolvedValueOnce(result(3))

    await expect(discoverInstalledAgentSkills(true, undefined)).resolves.toEqual(result(1))
    await expect(discoverInstalledAgentSkills(true, undefined)).resolves.toEqual(result(2))
    await expect(discoverInstalledAgentSkills(true, undefined)).resolves.toEqual(result(3))
    expect(discover).toHaveBeenCalledTimes(3)
  })

  it('collapses concurrent forced refreshes onto one scan', async () => {
    // Fan-out install notifications must share a refresh rather than serialize one scan per surface.
    const scan = deferred<SkillDiscoveryResult>()
    const discover = discoverSkillsForRuntimeTarget
    discover.mockReturnValue(scan.promise)

    const requests = [
      discoverInstalledAgentSkills(true, undefined),
      discoverInstalledAgentSkills(true, undefined),
      discoverInstalledAgentSkills(true, undefined)
    ]
    scan.resolve(result(1))

    await expect(Promise.all(requests)).resolves.toEqual([result(1), result(1), result(1)])
    expect(discover).toHaveBeenCalledTimes(1)
  })

  it('lets a superseded scan settle without evicting the newer pending scan', async () => {
    // An old scan settling after invalidation must not remove the new scan’s dedup entry.
    const staleScan = deferred<SkillDiscoveryResult>()
    const freshScan = deferred<SkillDiscoveryResult>()
    const lateScan = deferred<SkillDiscoveryResult>()
    const discover = discoverSkillsForRuntimeTarget
    discover.mockReturnValueOnce(staleScan.promise)
    discover.mockReturnValueOnce(freshScan.promise)
    discover.mockReturnValueOnce(lateScan.promise)

    const staleRequest = discoverInstalledAgentSkills(false, undefined)
    invalidateInstalledAgentSkillDiscovery()
    const freshRequest = discoverInstalledAgentSkills(false, undefined)

    staleScan.resolve(result(1))
    await expect(staleRequest).resolves.toEqual(result(1))

    const joinedRequest = discoverInstalledAgentSkills(false, undefined)
    expect(discover).toHaveBeenCalledTimes(2)

    freshScan.resolve(result(2))
    await expect(freshRequest).resolves.toEqual(result(2))
    await expect(joinedRequest).resolves.toEqual(result(2))
  })

  it('normalizes every target shape before it reaches discovery', async () => {
    const discover = discoverSkillsForRuntimeTarget
    discover.mockResolvedValue(result(1))

    await discoverInstalledAgentSkills(false, { runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(discover).toHaveBeenLastCalledWith(LOCAL, { runtime: 'wsl', wslDistro: 'Ubuntu' })

    await discoverInstalledAgentSkills(false, { projectRuntime: resolvedWslProjectRuntime })
    expect(discover).toHaveBeenLastCalledWith(LOCAL, {
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      projectRuntime: resolvedWslProjectRuntime
    })

    await discoverInstalledAgentSkills(false, { projectRuntime: resolvedHostProjectRuntime })
    expect(discover).toHaveBeenLastCalledWith(LOCAL, {
      runtime: 'host',
      projectRuntime: resolvedHostProjectRuntime
    })

    await discoverInstalledAgentSkills(false, { projectRuntime: repairProjectRuntime })
    expect(discover).toHaveBeenLastCalledWith(LOCAL, { projectRuntime: repairProjectRuntime })
  })

  it('keeps host, WSL, project, and filtered results in separate cache entries', async () => {
    const targets: (SkillDiscoveryTarget | undefined)[] = [
      undefined,
      { runtime: 'wsl', wslDistro: null },
      { runtime: 'wsl', wslDistro: 'Ubuntu' },
      { projectRuntime: resolvedHostProjectRuntime },
      { projectRuntime: resolvedWslProjectRuntime },
      { names: ['orchestration'], sourceKinds: ['home'] },
      { names: ['computer-use'], sourceKinds: ['home'] }
    ]
    for (const [index, target] of targets.entries()) {
      discoverSkillsForRuntimeTarget.mockResolvedValueOnce(result(index))
      await expect(discoverInstalledAgentSkills(false, target)).resolves.toEqual(result(index))
    }
    for (const [index, target] of targets.entries()) {
      await expect(discoverInstalledAgentSkills(false, target)).resolves.toEqual(result(index))
    }
    expect(discoverSkillsForRuntimeTarget).toHaveBeenCalledTimes(targets.length)
  })

  it('keys targets by runtime and project identity', () => {
    expect(getSkillDiscoveryTargetKey(undefined)).toBe('host')
    expect(getSkillDiscoveryTargetKey({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe('wsl:Ubuntu')
    expect(getSkillDiscoveryTargetKey({ projectRuntime: resolvedHostProjectRuntime })).toBe(
      'repo-1:windows-host'
    )
    expect(getSkillDiscoveryTargetKey({ projectRuntime: repairProjectRuntime })).toBe(
      'repo-1:repair:wsl-distro-required:default'
    )
  })

  it('normalizes effective filters into local, project, and environment keys', () => {
    const target = {
      projectRuntime: resolvedWslProjectRuntime,
      names: [' Computer-Use ', 'orchestration', 'computer-use'],
      sourceKinds: ['home' as const]
    }
    const normalizedFilters = [['computer-use', 'orchestration'], ['home']]

    expect(getSkillDiscoveryTargetKey(target)).toBe(
      JSON.stringify(['repo-1:wsl:Ubuntu', ...normalizedFilters])
    )
    expect(getRuntimeScopedSkillDiscoveryKey(remote('env-a'), target)).toBe(
      JSON.stringify(['runtime:env-a', ...normalizedFilters])
    )
    expect(getSkillDiscoveryTargetKey(target, [], [])).toBe(
      JSON.stringify(['repo-1:wsl:Ubuntu', ...normalizedFilters])
    )
    expect(getSkillDiscoveryTargetKey(target, ['ORCHESTRATION'], [])).toBe(
      JSON.stringify(['repo-1:wsl:Ubuntu', ['orchestration'], ['home']])
    )
  })

  it('keys the bounded cache by runtime scope, not by the client target', async () => {
    // Keep runtime-scoped remote keys through cache bounding; host-only target keys collapse environments (#6887).
    expect(getRuntimeScopedSkillDiscoveryKey(remote('env-a'), undefined)).toBe('runtime:env-a')
    expect(
      getRuntimeScopedSkillDiscoveryKey(remote('env-a'), { runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).toBe('runtime:env-a')
    expect(getRuntimeScopedSkillDiscoveryKey(LOCAL, { runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
      'wsl:Ubuntu'
    )

    const discover = discoverSkillsForRuntimeTarget
    discover.mockResolvedValueOnce(result(1))
    discover.mockResolvedValueOnce(result(2))
    discover.mockResolvedValueOnce(result(3))

    await expect(discoverInstalledAgentSkills(false, undefined, remote('env-a'))).resolves.toEqual(
      result(1)
    )
    await expect(discoverInstalledAgentSkills(false, undefined, remote('env-b'))).resolves.toEqual(
      result(2)
    )
    await expect(discoverInstalledAgentSkills(false, undefined, LOCAL)).resolves.toEqual(result(3))
    expect(discover).toHaveBeenCalledTimes(3)

    await expect(discoverInstalledAgentSkills(false, undefined, remote('env-a'))).resolves.toEqual(
      result(1)
    )
    await expect(discoverInstalledAgentSkills(false, undefined, remote('env-b'))).resolves.toEqual(
      result(2)
    )
    await expect(discoverInstalledAgentSkills(false, undefined, LOCAL)).resolves.toEqual(result(3))
    expect(discover).toHaveBeenCalledTimes(3)
  })

  it('collapses one remote environment onto a single entry across client target shapes', async () => {
    // Remote scans drop client target shape, which must not fragment their cache keys.
    const discover = discoverSkillsForRuntimeTarget
    discover.mockResolvedValue(result(1))

    await discoverInstalledAgentSkills(
      false,
      { runtime: 'wsl', wslDistro: 'Ubuntu' },
      remote('env-a')
    )
    await discoverInstalledAgentSkills(
      false,
      { projectRuntime: resolvedWslProjectRuntime },
      remote('env-a')
    )
    await discoverInstalledAgentSkills(false, undefined, remote('env-a'))

    expect(discover).toHaveBeenCalledTimes(1)
  })
})
