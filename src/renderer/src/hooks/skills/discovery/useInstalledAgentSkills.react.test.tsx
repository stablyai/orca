// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoverySource,
  SkillDiscoveryTarget
} from '../../../../../shared/skills'

import type { GlobalSettings } from '../../../../../shared/global-settings-types'

import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { useAppStore } from '@/store/index'
import { resetSkillDiscoveryCacheForTests } from './installed-agent-skill-discovery'

import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  type InstalledAgentSkillState,
  notifyInstalledAgentSkillsRefreshed,
  useInstalledAgentSkillNames
} from './useInstalledAgentSkills'

let root: Root | null = null
let container: HTMLDivElement | null = null
let latestState: InstalledAgentSkillState | null = null
const renderedStates: InstalledAgentSkillState[] = []
/** When set, the next Probe render suspends on it, so React throws that render away. */
let suspendNextProbeRender: Promise<void> | null = null

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

function discoveryResult(
  skills: DiscoveredSkill[] = [],
  sources: SkillDiscoverySource[] = []
): SkillDiscoveryResult {
  return {
    skills,
    sources,
    scannedAt: 1
  }
}

/** A root the host could not read: it reports `exists` because it cannot prove otherwise. */
function unavailableSource(overrides: Partial<SkillDiscoverySource> = {}): SkillDiscoverySource {
  return {
    id: 'home',
    label: 'Agent skills home',
    path: '/Users/test/.agents/skills',
    sourceKind: 'home',
    providers: ['agent-skills'],
    owner: null,
    exists: true,
    skippedReason: 'unavailable',
    ...overrides
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

function Probe({ discoveryTarget }: { discoveryTarget?: SkillDiscoveryTarget }): null {
  latestState = useInstalledAgentSkillNames(LINEAR_AGENT_SKILL_NAMES, {
    discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  if (suspendNextProbeRender) {
    const pending = suspendNextProbeRender
    suspendNextProbeRender = null
    throw pending
  }
  renderedStates.push(latestState)
  return null
}

function ensureRoot(): Root {
  if (!container) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  return root!
}

async function renderProbe(discoveryTarget?: SkillDiscoveryTarget): Promise<void> {
  const probeRoot = ensureRoot()
  await act(async () => {
    probeRoot.render(<Probe discoveryTarget={discoveryTarget} />)
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
  suspendNextProbeRender = null
  resetSkillDiscoveryCacheForTests()
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
  // Unread roots contain unknown skills; claiming absent would offer Install for existing skills.

  it('keeps a negative authoritative when the unread root is out of scope', async () => {
    const scan = deferred<SkillDiscoveryResult>()
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockReturnValue(scan.promise)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe()
    // The probe asks only about home roots, so a stalled repo root proves nothing.
    scan.resolve(
      discoveryResult([], [unavailableSource({ id: 'repo', sourceKind: 'repo', path: '/repo' })])
    )
    await act(async () => {
      await scan.promise
    })

    expect(latestState?.installed).toBe(false)
    expect(latestState?.error).toBeNull()
  })

  it('does not flag an incomplete scan once the skill is found anyway', async () => {
    const scan = deferred<SkillDiscoveryResult>()
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockReturnValue(scan.promise)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe()
    scan.resolve(discoveryResult([skill({ name: 'orca-linear' })], [unavailableSource()]))
    await act(async () => {
      await scan.promise
    })

    expect(latestState?.installed).toBe(true)
    expect(latestState?.error).toBeNull()
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

    // Forced recheck bypasses without clearing cache, allowing concurrent silent reads to reuse its answer.
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

  // Scan must match install’s ambiguity-resolving owner policy; guessing focused remote while install routes local strands badges (#6789).

  it('keeps loading instead of scanning the wrong host before the catalog settles', async () => {
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValue(discoveryResult([]))
    const call = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover }, runtimeEnvironments: { call } }
    })
    // Known-but-unsettled remote ownership must not fall back and cache a client scan.
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

  // Failed catalog reads degrade locally instead of leaving every skill badge permanently pending.

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

  // Same-ID re-pair must invalidate mounted results as well as module cache and scan the new peer.

  // React discards render state updates but not ref writes; render-phase ref resets formerly left old-target results visible after suspension.
})
