import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../../shared/skills'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

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
  evictSkillDiscoveryForRuntimeEnvironments,
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

    // Why: the stale scan must settle LAST — that is the only ordering where a
    // missing generation guard would overwrite the post-install result.
    freshScan.resolve(result(2))
    await expect(freshRequest).resolves.toEqual(result(2))
    staleScan.resolve(result(1))
    await expect(staleRequest).resolves.toEqual(result(1))

    await expect(discoverInstalledAgentSkills(false, target)).resolves.toEqual(result(2))
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('serves a warm cache unforced and rescans when forced', async () => {
    // Why: the focus listener and every "re-check" action force a refresh so a
    // skill installed outside Orca is detected; a warm cache must not short it.
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
    // Why: without the settle-time cleanup the pending map grows forever and
    // every later forced refresh resolves the first, already-settled scan.
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
    // Why: an install notification fans out to every mounted skill surface at
    // once; each forces a refresh and they must not serialize into N scans.
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
    // Why: invalidation clears the pending map mid-flight, so the pre-install
    // scan must not tear down the post-install scan's dedup entry when it lands.
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

    // The post-install scan is still in flight, so this must dedupe onto it
    // rather than start a third scan.
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

  it('keys WSL targets by distro so two distros do not share one entry', async () => {
    const discover = discoverSkillsForRuntimeTarget
    discover.mockResolvedValueOnce(result(1))
    discover.mockResolvedValueOnce(result(2))

    await expect(
      discoverInstalledAgentSkills(false, { runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).resolves.toEqual(result(1))
    await expect(
      discoverInstalledAgentSkills(false, { runtime: 'wsl', wslDistro: 'Debian' })
    ).resolves.toEqual(result(2))
    await expect(
      discoverInstalledAgentSkills(false, { runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).resolves.toEqual(result(1))
    expect(discover).toHaveBeenCalledTimes(2)
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
  it('keys the bounded cache by runtime scope, not by the client target', async () => {
    // Why: #6887 scopes remote scans by environment. The cap rewrites this same
    // module, so pin that getRuntimeScopedSkillDiscoveryKey stays the producer —
    // keying off getSkillDiscoveryTargetKey would bound remotes under 'host'.
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

    // Two environments must not share an entry, and neither may serve the local key.
    await expect(discoverInstalledAgentSkills(false, undefined, remote('env-a'))).resolves.toEqual(
      result(1)
    )
    await expect(discoverInstalledAgentSkills(false, undefined, remote('env-b'))).resolves.toEqual(
      result(2)
    )
    await expect(discoverInstalledAgentSkills(false, undefined, LOCAL)).resolves.toEqual(result(3))
    expect(discover).toHaveBeenCalledTimes(3)

    // ...and each is independently cached under its own runtime-scoped key.
    await expect(discoverInstalledAgentSkills(false, undefined, remote('env-a'))).resolves.toEqual(
      result(1)
    )
    await expect(discoverInstalledAgentSkills(false, undefined, remote('env-b'))).resolves.toEqual(
      result(2)
    )
    await expect(discoverInstalledAgentSkills(false, undefined, LOCAL)).resolves.toEqual(result(3))
    expect(discover).toHaveBeenCalledTimes(3)
  })

  it('evicts only the retired environments, leaving other entries warm', async () => {
    // Why: a flush would re-fire every mounted consumer's scan.
    const discover = discoverSkillsForRuntimeTarget
    discover.mockResolvedValueOnce(result(1))
    discover.mockResolvedValueOnce(result(2))
    discover.mockResolvedValueOnce(result(3))
    await discoverInstalledAgentSkills(false, undefined, remote('env-a'))
    await discoverInstalledAgentSkills(false, undefined, remote('env-b'))
    await discoverInstalledAgentSkills(false, undefined, LOCAL)

    evictSkillDiscoveryForRuntimeEnvironments(['env-a'])

    await expect(discoverInstalledAgentSkills(false, undefined, remote('env-b'))).resolves.toEqual(
      result(2)
    )
    await expect(discoverInstalledAgentSkills(false, undefined, LOCAL)).resolves.toEqual(result(3))
    expect(discover).toHaveBeenCalledTimes(3)
    discover.mockResolvedValueOnce(result(4))
    await expect(discoverInstalledAgentSkills(false, undefined, remote('env-a'))).resolves.toEqual(
      result(4)
    )
    expect(discover).toHaveBeenCalledTimes(4)
  })

  it('does not let a scan in flight at eviction time repopulate the retired entry', async () => {
    // Why: VM teardown can race a scan already in flight.
    const staleScan = deferred<SkillDiscoveryResult>()
    const discover = discoverSkillsForRuntimeTarget
    discover.mockReturnValueOnce(staleScan.promise)

    const staleRequest = discoverInstalledAgentSkills(false, undefined, remote('env-a'))
    evictSkillDiscoveryForRuntimeEnvironments(['env-a'])
    staleScan.resolve(result(1))
    await expect(staleRequest).resolves.toEqual(result(1))

    discover.mockResolvedValueOnce(result(2))
    await expect(discoverInstalledAgentSkills(false, undefined, remote('env-a'))).resolves.toEqual(
      result(2)
    )
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('collapses one remote environment onto a single entry across client target shapes', async () => {
    // Why: the client target is dropped for a remote scan, so it must not
    // fragment the key either — otherwise one remote rescans per target shape.
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
