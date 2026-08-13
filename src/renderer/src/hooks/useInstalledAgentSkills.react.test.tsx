// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoveryTarget
} from '../../../shared/skills'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { GlobalSettings } from '../../../shared/types'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { INSTALLED_AGENT_SKILL_DISCOVERY_FRESH_MS } from './installed-agent-skill-discovery-cache'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  type InstalledAgentSkillState,
  _installedAgentSkillDiscoveryInternalsForTests,
  notifyInstalledAgentSkillsChanged,
  notifyInstalledAgentSkillsRefreshed,
  useInstalledAgentSkillNames
} from './useInstalledAgentSkills'

let root: Root | null = null
let container: HTMLDivElement | null = null
let latestState: InstalledAgentSkillState | null = null
const renderedStates: InstalledAgentSkillState[] = []

function skill(overrides: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: 'skill-1',
    name: 'Example Skill',
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: '/Users/test/.agents/skills',
    directoryPath: '/Users/test/.agents/skills/example-skill',
    skillFilePath: '/Users/test/.agents/skills/example-skill/SKILL.md',
    installed: true,
    updatedAt: null,
    ...overrides
  }
}

function discoveryResult(skills: DiscoveredSkill[] = []): SkillDiscoveryResult {
  return {
    skills,
    sources: [],
    scannedAt: Date.now()
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const LINEAR_AGENT_SKILL_NAMES = ['orca-linear', 'linear-tickets'] as const

const projectWslRuntime: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'repo-1',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'repo-1:wsl:Ubuntu'
  }
}

function Probe({ discoveryTarget }: { discoveryTarget?: SkillDiscoveryTarget }): null {
  latestState = useInstalledAgentSkillNames(LINEAR_AGENT_SKILL_NAMES, {
    discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  renderedStates.push(latestState)
  return null
}

async function renderProbe(discoveryTarget?: SkillDiscoveryTarget): Promise<void> {
  if (!container) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(<Probe discoveryTarget={discoveryTarget} />)
  })
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = null
  container?.remove()
  container = null
  latestState = null
  renderedStates.length = 0
  _installedAgentSkillDiscoveryInternalsForTests.reset()
  clearRuntimeCompatibilityCacheForTests()
  useAppStore.setState({
    settings: null,
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogSettled: false
  })
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'api')
})

/** Drain the compat probe + RPC promise chain a remote scan walks before it lands in state. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve()
    }
  })
}

/**
 * Hydrate the store the way a running app does. `savedEnvironmentIds` defaults to
 * just the focused one, which is the only shape that resolves to a remote owner.
 */
function setRuntimeOwner(
  environmentId: string | null,
  savedEnvironmentIds: readonly string[] = environmentId ? [environmentId] : []
): void {
  useAppStore.setState({
    settings: { activeRuntimeEnvironmentId: environmentId } as GlobalSettings,
    runtimeEnvironments: savedEnvironmentIds.map((id) => ({ id })) as never,
    runtimeEnvironmentCatalogSettled: true
  })
}

beforeEach(() => {
  setRuntimeOwner(null)
})

describe('useInstalledAgentSkill', () => {
  it('ignores stale discovery results after the discovery target changes', async () => {
    const hostScan = deferred<SkillDiscoveryResult>()
    const wslScan = deferred<SkillDiscoveryResult>()
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockReturnValueOnce(hostScan.promise)
      .mockReturnValueOnce(wslScan.promise)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe()
    await renderProbe({ runtime: 'wsl', wslDistro: 'Fedora' })

    wslScan.resolve(discoveryResult([]))
    await act(async () => {
      await wslScan.promise
    })

    expect(latestState?.installed).toBe(false)

    hostScan.resolve(discoveryResult([skill({ name: 'linear-tickets' })]))
    await act(async () => {
      await hostScan.promise
    })

    expect(latestState?.installed).toBe(false)
    expect(discover).toHaveBeenNthCalledWith(1, undefined)
    expect(discover).toHaveBeenNthCalledWith(2, { runtime: 'wsl', wslDistro: 'Fedora' })
  })

  it('ignores same-target background discovery results when a forced refresh is waiting', async () => {
    const backgroundScan = deferred<SkillDiscoveryResult>()
    const forcedScan = deferred<SkillDiscoveryResult>()
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockReturnValueOnce(backgroundScan.promise)
      .mockReturnValueOnce(forcedScan.promise)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe()

    const forcedRefresh = latestState?.refresh() ?? Promise.resolve()

    backgroundScan.resolve(discoveryResult([skill({ name: 'linear-tickets' })]))
    await act(async () => {
      await backgroundScan.promise
      await Promise.resolve()
    })

    expect(latestState?.installed).toBe(false)
    expect(discover).toHaveBeenCalledTimes(2)

    forcedScan.resolve(discoveryResult([]))
    await act(async () => {
      await forcedRefresh
    })

    expect(latestState?.installed).toBe(false)
    expect(discover).toHaveBeenNthCalledWith(1, undefined)
    // A forced refresh must also bypass the host's shared scans, not just this cache.
    expect(discover).toHaveBeenNthCalledWith(2, { refresh: true })
  })

  it('returns installed from refresh when a legacy Linear skill is discovered', async () => {
    const backgroundScan = deferred<SkillDiscoveryResult>()
    const forcedScan = deferred<SkillDiscoveryResult>()
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockReturnValueOnce(backgroundScan.promise)
      .mockReturnValueOnce(forcedScan.promise)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe()

    const forcedRefresh = latestState?.refresh() ?? Promise.resolve(false)
    backgroundScan.resolve(discoveryResult([]))
    await act(async () => {
      await backgroundScan.promise
    })

    forcedScan.resolve(discoveryResult([skill({ name: 'linear-tickets' })]))
    let installed = false
    await act(async () => {
      installed = await forcedRefresh
    })

    expect(installed).toBe(true)
    expect(latestState?.installed).toBe(true)
  })

  it('detects a legacy Linear install through WSL skill discovery', async () => {
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValue(discoveryResult([skill({ name: 'linear-tickets' })]))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    await act(async () => {
      await Promise.resolve()
    })

    expect(latestState?.installed).toBe(true)
    expect(discover).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('detects a legacy Linear install through project-runtime skill discovery', async () => {
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValue(discoveryResult([skill({ name: 'linear-tickets' })]))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe({ projectRuntime: projectWslRuntime })
    await act(async () => {
      await Promise.resolve()
    })

    expect(latestState?.installed).toBe(true)
    expect(discover).toHaveBeenCalledWith({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      projectRuntime: projectWslRuntime
    })
  })

  it('serves a focus rescan from cache so window switching does not walk disk', async () => {
    // Why: the freshness window is wall-clock, so pin the clock — a stalled runner
    // could otherwise cross it mid-test and turn this into a flake.
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const firstScan = deferred<SkillDiscoveryResult>()
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockReturnValueOnce(firstScan.promise)
      .mockResolvedValue(discoveryResult([skill({ name: 'orca-linear' })]))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe()
    expect(latestState?.settled).toBe(false)

    firstScan.resolve(discoveryResult([skill({ name: 'orca-linear' })]))
    await act(async () => {
      await firstScan.promise
    })
    expect(latestState?.settled).toBe(true)
    expect(latestState?.installed).toBe(true)
    expect(discover).toHaveBeenCalledTimes(1)

    for (let focusEvent = 0; focusEvent < 5; focusEvent += 1) {
      await act(async () => {
        window.dispatchEvent(new Event('focus'))
      })
      await flushMicrotasks()
    }

    // Focus is a backstop, not a mutation signal: a burst of window switches
    // costs no scans, and the surface never flashes unsettled.
    expect(discover).toHaveBeenCalledTimes(1)
    expect(latestState?.loading).toBe(false)
    expect(latestState?.settled).toBe(true)
    expect(latestState?.installed).toBe(true)
  })

  it('rescans on focus once the cached scan is no longer fresh', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    const startedAt = 1_700_000_000_000
    nowSpy.mockReturnValue(startedAt)
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValue(discoveryResult([skill({ name: 'orca-linear' })]))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe()
    await flushMicrotasks()
    expect(discover).toHaveBeenCalledTimes(1)

    nowSpy.mockReturnValue(startedAt + INSTALLED_AGENT_SKILL_DISCOVERY_FRESH_MS + 1)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flushMicrotasks()

    // The freshness window is what bounds the storm; past it, focus still reads disk.
    expect(discover).toHaveBeenCalledTimes(2)
    expect(discover).toHaveBeenLastCalledWith(undefined)
  })

  it('reuses cached discovery when another surface finishes re-checking', async () => {
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValue(discoveryResult([skill({ name: 'orca-linear' })]))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    expect(discover).toHaveBeenCalledTimes(1)

    await act(async () => {
      notifyInstalledAgentSkillsRefreshed()
      await Promise.resolve()
    })

    expect(discover).toHaveBeenCalledTimes(1)
    expect(latestState?.installed).toBe(true)
  })

  it('clears loading when a silent refresh supersedes an in-flight forced rescan', async () => {
    const firstScan = deferred<SkillDiscoveryResult>()
    const forcedScan = deferred<SkillDiscoveryResult>()
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockReturnValueOnce(firstScan.promise)
      .mockReturnValueOnce(forcedScan.promise)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe()
    firstScan.resolve(discoveryResult([skill({ name: 'orca-linear' })]))
    await act(async () => {
      await firstScan.promise
    })

    // The recheck button forces past the cache without clearing it, so the silent
    // refresh below can still be served from it while this scan is in flight.
    await act(async () => {
      void latestState?.refresh()
    })
    expect(latestState?.loading).toBe(true)

    // The silent refresh takes over the generation, so it owns the spinner too.
    await act(async () => {
      notifyInstalledAgentSkillsRefreshed()
      await Promise.resolve()
    })
    await flushMicrotasks()
    expect(latestState?.loading).toBe(false)

    forcedScan.resolve(discoveryResult([skill({ name: 'orca-linear' })]))
    await act(async () => {
      await forcedScan.promise
    })
    expect(latestState?.loading).toBe(false)
  })

  it('reports unsettled again when the discovery target changes', async () => {
    const hostScan = deferred<SkillDiscoveryResult>()
    const wslScan = deferred<SkillDiscoveryResult>()
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockReturnValueOnce(hostScan.promise)
      .mockReturnValueOnce(wslScan.promise)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe()
    hostScan.resolve(discoveryResult([skill({ name: 'orca-linear' })]))
    await act(async () => {
      await hostScan.promise
    })
    expect(latestState?.settled).toBe(true)

    await renderProbe({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(latestState?.settled).toBe(false)

    wslScan.resolve(discoveryResult([]))
    await act(async () => {
      await wslScan.promise
    })
    expect(latestState?.settled).toBe(true)
    expect(latestState?.installed).toBe(false)
  })

  it('scans the connected remote runtime and keeps that result out of the local cache', async () => {
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValue(discoveryResult([]))
    const call = vi.fn(
      async (args: { method: string; selector?: string }) =>
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'skills',
          ok: true,
          result: discoveryResult([skill({ name: 'linear-tickets' })])
        }
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover }, runtimeEnvironments: { call } }
    })
    setRuntimeOwner('env-1')

    await renderProbe()
    await flushMicrotasks()

    expect(latestState?.installed).toBe(true)
    expect(discover).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-1', method: 'skills.discover' })
    )

    // Why: the remote hit is keyed per environment, so switching back to the
    // local host must re-scan the client instead of replaying the server's list.
    await act(async () => {
      setRuntimeOwner(null)
    })
    await flushMicrotasks()

    expect(discover).toHaveBeenCalledTimes(1)
    expect(latestState?.installed).toBe(false)
  })

  // Why: the skill INSTALL terminal routes through getSingleFocusedRuntimeEnvironmentId,
  // which refuses to guess an owner while several runtimes are saved. Scanning the
  // focused remote here would leave the badge stuck on "Not installed" forever,
  // because the install actually lands on the local client.
  it('scans the local host when several saved runtimes make the install host ambiguous', async () => {
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValue(discoveryResult([skill({ name: 'linear-tickets' })]))
    const call = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover }, runtimeEnvironments: { call } }
    })
    setRuntimeOwner('env-1', ['env-1', 'env-2'])

    await renderProbe()
    await flushMicrotasks()

    expect(call).not.toHaveBeenCalled()
    expect(discover).toHaveBeenCalledTimes(1)
    expect(latestState?.installed).toBe(true)
  })

  it('keeps loading instead of scanning the wrong host before the catalog settles', async () => {
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValue(discoveryResult([]))
    const call = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover }, runtimeEnvironments: { call } }
    })
    // Why: a focused remote is already known here, so a missing gate resolves to
    // the local host and caches a client scan under the local key.
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as GlobalSettings,
      runtimeEnvironments: [{ id: 'env-1' }] as never,
      runtimeEnvironmentCatalogSettled: false
    })

    await renderProbe()
    await flushMicrotasks()

    expect(discover).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    expect(latestState?.loading).toBe(true)
    expect(latestState?.installed).toBe(false)
  })

  // Why: a failed catalog read must degrade to the local host, not strand every
  // skill badge on a spinner with no retry affordance for the whole session.
  it('falls back to the local host once an unreadable catalog settles', async () => {
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValue(discoveryResult([skill({ name: 'linear-tickets' })]))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover }, runtimeEnvironments: { call: vi.fn() } }
    })
    useAppStore.setState({
      settings: null,
      runtimeEnvironments: [],
      runtimeEnvironmentCatalogSettled: true
    })

    await renderProbe()
    await flushMicrotasks()

    expect(discover).toHaveBeenCalledTimes(1)
    expect(latestState?.loading).toBe(false)
    expect(latestState?.installed).toBe(true)
  })
  it('does not rescan when a caller rebuilds an equivalent target object', async () => {
    // Why: callers derive the target inside a store-backed useMemo, so an
    // unrelated store write hands this hook a new object with the same key.
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockRejectedValue(new Error('runtime host unreachable'))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe({ projectRuntime: projectWslRuntime })
    await flushMicrotasks()
    expect(discover).toHaveBeenCalledTimes(1)

    for (let rebuild = 0; rebuild < 5; rebuild += 1) {
      await renderProbe({ projectRuntime: { ...projectWslRuntime } })
      await flushMicrotasks()
    }

    // A failed scan caches nothing, so an unstable target identity would issue a
    // fresh discovery per store write for as long as the host stays unreachable.
    expect(discover).toHaveBeenCalledTimes(1)
    expect(latestState?.error).toBe('runtime host unreachable')
  })

  it('hydrates from the warm cache on its very first render pass', async () => {
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValue(discoveryResult([skill({ name: 'linear-tickets' })]))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe()
    await flushMicrotasks()
    expect(latestState?.installed).toBe(true)

    await act(async () => {
      root?.unmount()
    })
    root = null
    container = null
    renderedStates.length = 0
    await renderProbe()

    // The first render pass, before any effect runs, must already be settled.
    expect(renderedStates[0]?.loading).toBe(false)
    expect(renderedStates[0]?.installed).toBe(true)
  })

  it('empties the discovery cache when an install notification fires', async () => {
    // Why: assert the cache directly — a mounted component forces a rescan and
    // would hide a missing invalidation.
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValueOnce(discoveryResult([]))
      .mockResolvedValue(discoveryResult([skill({ name: 'linear-tickets' })]))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    const { discoverInstalledAgentSkills } = _installedAgentSkillDiscoveryInternalsForTests
    await discoverInstalledAgentSkills(false, undefined)
    await expect(discoverInstalledAgentSkills(false, undefined)).resolves.toEqual(
      expect.objectContaining({ skills: [] })
    )
    expect(discover).toHaveBeenCalledTimes(1)

    notifyInstalledAgentSkillsChanged()

    await expect(discoverInstalledAgentSkills(false, undefined)).resolves.toEqual(
      expect.objectContaining({ skills: [expect.objectContaining({ name: 'linear-tickets' })] })
    )
    expect(discover).toHaveBeenCalledTimes(2)
  })
})
