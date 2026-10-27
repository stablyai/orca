import type {
  SkillDiscoveryResult,
  SkillDiscoveryTarget,
  SkillSourceKind
} from '../../../shared/skills'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { discoverSkillsForRuntimeTarget } from '@/runtime/runtime-skills-client'
import { INSTALLED_AGENT_SKILLS_CHANGED_EVENT } from './installed-agent-skills-change-event'
import {
  clearInstalledAgentSkillDiscoveryCache,
  deleteInstalledAgentSkillDiscoveryCache,
  peekInstalledAgentSkillDiscoveryCache,
  readInstalledAgentSkillDiscoveryCache,
  resetInstalledAgentSkillDiscoveryCacheForTests,
  writeInstalledAgentSkillDiscoveryCache
} from './installed-agent-skill-discovery-cache'

export const LOCAL_RUNTIME_TARGET: RuntimeClientTarget = { kind: 'local' }

let discoveryGeneration = 0
let pendingDiscoveryByTarget = new Map<string, Promise<SkillDiscoveryResult>>()
let pendingDiscoverySatisfiesForcedRefreshByTarget = new Map<string, boolean>()

/** Last completed scan for a runtime-scoped key, for a synchronous first render. */
export function getCachedSkillDiscovery(key: string): SkillDiscoveryResult | null {
  return peekInstalledAgentSkillDiscoveryCache(key)
}

/** Invalidate every cached scan and tell mounted hooks to re-scan (e.g. after an install). */
export function notifyInstalledAgentSkillsChanged(): void {
  invalidateInstalledAgentSkillDiscovery()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(INSTALLED_AGENT_SKILLS_CHANGED_EVENT))
  }
}

export function invalidateInstalledAgentSkillDiscovery(): void {
  discoveryGeneration += 1
  clearInstalledAgentSkillDiscoveryCache()
  // Install/uninstall advances generation so older reads cannot repopulate the cache.
  pendingDiscoveryByTarget.clear()
  pendingDiscoverySatisfiesForcedRefreshByTarget.clear()
}

export function evictInstalledAgentSkillDiscoveryForRuntimeEnvironments(
  environmentIds: Iterable<string>
): void {
  for (const environmentId of environmentIds) {
    const key = getRuntimeScopedSkillDiscoveryKey({ kind: 'environment', environmentId }, undefined)
    const filteredPrefix = `[${JSON.stringify(key)},`
    const belongsToRuntime = (candidate: string): boolean =>
      candidate === key || candidate.startsWith(filteredPrefix)
    deleteInstalledAgentSkillDiscoveryCache(belongsToRuntime)
    for (const pendingKey of pendingDiscoveryByTarget.keys()) {
      if (belongsToRuntime(pendingKey)) {
        pendingDiscoveryByTarget.delete(pendingKey)
        pendingDiscoverySatisfiesForcedRefreshByTarget.delete(pendingKey)
      }
    }
  }
}

export function resetSkillDiscoveryCacheForTests(): void {
  invalidateInstalledAgentSkillDiscovery()
  resetInstalledAgentSkillDiscoveryCacheForTests()
  pendingDiscoveryByTarget = new Map()
  pendingDiscoverySatisfiesForcedRefreshByTarget = new Map()
}

function normalizeSkillDiscoveryTarget(
  target: SkillDiscoveryTarget | undefined,
  names?: readonly string[],
  sourceKinds?: readonly SkillSourceKind[]
): SkillDiscoveryTarget | undefined {
  const requestedNames = names?.map((name) => name.trim().toLowerCase()).filter(Boolean) ?? []
  const targetNames = target?.names?.map((name) => name.trim().toLowerCase()).filter(Boolean) ?? []
  const effectiveNames = [...new Set(requestedNames.length > 0 ? requestedNames : targetNames)]
  const effectiveSourceKinds = [
    ...new Set(sourceKinds?.length ? sourceKinds : (target?.sourceKinds ?? []))
  ]
  const filters = {
    ...(effectiveNames?.length ? { names: [...effectiveNames] } : {}),
    ...(effectiveSourceKinds?.length ? { sourceKinds: [...effectiveSourceKinds] } : {})
  }
  const projectRuntime = target?.projectRuntime
  if (projectRuntime) {
    if (projectRuntime.status === 'repair-required') {
      return { projectRuntime, ...filters }
    }
    if (projectRuntime.runtime.kind === 'wsl') {
      return {
        runtime: 'wsl',
        wslDistro: projectRuntime.runtime.distro,
        projectRuntime,
        ...filters
      }
    }
    return {
      runtime: 'host',
      projectRuntime,
      ...filters
    }
  }

  if (target?.runtime !== 'wsl') {
    return Object.keys(filters).length > 0 ? filters : undefined
  }
  return { runtime: 'wsl', wslDistro: target.wslDistro?.trim() || null, ...filters }
}

function appendSkillDiscoveryFiltersToKey(
  runtimeKey: string,
  target: SkillDiscoveryTarget | undefined
): string {
  return target?.names?.length || target?.sourceKinds?.length
    ? JSON.stringify([
        runtimeKey,
        target.names ? [...target.names].sort() : null,
        target.sourceKinds ? [...target.sourceKinds].sort() : null
      ])
    : runtimeKey
}

function getNormalizedSkillDiscoveryRuntimeKey(target: SkillDiscoveryTarget | undefined): string {
  if (target?.projectRuntime) {
    return target.projectRuntime.status === 'resolved'
      ? target.projectRuntime.runtime.cacheKey
      : target.projectRuntime.repair.cacheKey
  }
  return target?.runtime === 'wsl' ? `wsl:${target.wslDistro ?? ''}` : 'host'
}

export function getSkillDiscoveryTargetKey(
  target: SkillDiscoveryTarget | undefined,
  names?: readonly string[],
  sourceKinds?: readonly SkillSourceKind[]
): string {
  const normalizedTarget = normalizeSkillDiscoveryTarget(target, names, sourceKinds)
  return appendSkillDiscoveryFiltersToKey(
    getNormalizedSkillDiscoveryRuntimeKey(normalizedTarget),
    normalizedTarget
  )
}

// Remote scans read the remote disk: isolate environment keys from local results and omit client target shape to avoid duplicate scans.
export function getRuntimeScopedSkillDiscoveryKey(
  runtimeTarget: RuntimeClientTarget,
  target: SkillDiscoveryTarget | undefined,
  names?: readonly string[],
  sourceKinds?: readonly SkillSourceKind[]
): string {
  const normalizedTarget = normalizeSkillDiscoveryTarget(target, names, sourceKinds)
  const runtimeKey =
    runtimeTarget.kind === 'environment'
      ? `runtime:${runtimeTarget.environmentId}`
      : getNormalizedSkillDiscoveryRuntimeKey(normalizedTarget)
  return appendSkillDiscoveryFiltersToKey(runtimeKey, normalizedTarget)
}

function startInstalledAgentSkillDiscovery(
  force: boolean,
  target: SkillDiscoveryTarget | undefined,
  runtimeTarget: RuntimeClientTarget,
  key: string,
  names?: readonly string[],
  sourceKinds?: readonly SkillSourceKind[]
): Promise<SkillDiscoveryResult> {
  const generation = discoveryGeneration
  const normalizedTarget = normalizeSkillDiscoveryTarget(target, names, sourceKinds)
  // Forced post-mutation rechecks must bypass host scan sharing as well as window cache.
  const requestTarget = force ? { ...normalizedTarget, refresh: true } : normalizedTarget
  const discovery = discoverSkillsForRuntimeTarget(runtimeTarget, requestTarget)
    .then((result) => {
      if (generation === discoveryGeneration && pendingDiscoveryByTarget.get(key) === discovery) {
        writeInstalledAgentSkillDiscoveryCache(key, result)
      }
      return result
    })
    .finally(() => {
      if (pendingDiscoveryByTarget.get(key) === discovery) {
        pendingDiscoveryByTarget.delete(key)
        pendingDiscoverySatisfiesForcedRefreshByTarget.delete(key)
      }
    })
  pendingDiscoveryByTarget.set(key, discovery)
  pendingDiscoverySatisfiesForcedRefreshByTarget.set(key, force)
  return discovery
}

/** Share one pending scan per runtime-scoped key; force rereads disk. */
export async function discoverInstalledAgentSkills(
  force: boolean,
  target?: SkillDiscoveryTarget,
  runtimeTarget: RuntimeClientTarget = LOCAL_RUNTIME_TARGET,
  names?: readonly string[],
  sourceKinds?: readonly SkillSourceKind[]
): Promise<SkillDiscoveryResult> {
  const key = getRuntimeScopedSkillDiscoveryKey(runtimeTarget, target, names, sourceKinds)
  if (!force) {
    // Promote only cache-serving reads; forced refresh discards the entry instead.
    const cachedDiscovery = readInstalledAgentSkillDiscoveryCache(key)
    if (cachedDiscovery) {
      return cachedDiscovery
    }
  }

  const inFlightDiscovery = pendingDiscoveryByTarget.get(key)
  if (inFlightDiscovery) {
    if (!force || pendingDiscoverySatisfiesForcedRefreshByTarget.get(key)) {
      return inFlightDiscovery
    }
    try {
      await inFlightDiscovery
    } catch {
      // Explicit rechecks still read disk after earlier background scan failure.
    }
    const nextPendingDiscovery = pendingDiscoveryByTarget.get(key)
    if (nextPendingDiscovery && nextPendingDiscovery !== inFlightDiscovery) {
      return nextPendingDiscovery
    }
  }

  return startInstalledAgentSkillDiscovery(force, target, runtimeTarget, key, names, sourceKinds)
}
