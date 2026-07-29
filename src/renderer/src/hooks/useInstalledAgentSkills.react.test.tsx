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
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  type InstalledAgentSkillState,
  _installedAgentSkillDiscoveryInternalsForTests,
  useInstalledAgentSkillNames
} from './useInstalledAgentSkills'

let root: Root | null = null
let container: HTMLDivElement | null = null
let latestState: InstalledAgentSkillState | null = null

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
    fileCount: 1,
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
    expect(discover).toHaveBeenNthCalledWith(2, undefined)
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
})
