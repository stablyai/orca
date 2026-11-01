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
type PendingDiscovery = {
  promise: Promise<SkillDiscoveryResult>
  force: boolean
  retryOnFailure: boolean
  recoveryEpoch: number | undefined
}
let pendingDiscoveryByTarget = new Map<string, PendingDiscovery>()

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
      }
    }
  }
}

export function resetSkillDiscoveryCacheForTests(): void {
  invalidateInstalledAgentSkillDiscovery()
  resetInstalledAgentSkillDiscoveryCacheForTests()
  pendingDiscoveryByTarget = new Map()
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
  target: SkillDiscoveryTarget | undefined,
  runtimeIdentity?: string
): string {
  return runtimeIdentity || target?.names?.length || target?.sourceKinds?.length
    ? JSON.stringify([
        runtimeKey,
        target?.names ? [...target.names].sort() : null,
        target?.sourceKinds ? [...target.sourceKinds].sort() : null,
        ...(runtimeIdentity ? [runtimeIdentity] : [])
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
  sourceKinds?: readonly SkillSourceKind[],
  runtimeIdentity?: string
): string {
  const normalizedTarget = normalizeSkillDiscoveryTarget(target, names, sourceKinds)
  const runtimeKey =
    runtimeTarget.kind === 'environment'
      ? `runtime:${runtimeTarget.environmentId}`
      : getNormalizedSkillDiscoveryRuntimeKey(normalizedTarget)
  return appendSkillDiscoveryFiltersToKey(runtimeKey, normalizedTarget, runtimeIdentity)
}

function startInstalledAgentSkillDiscovery(
  force: boolean,
  target: SkillDiscoveryTarget | undefined,
  runtimeTarget: RuntimeClientTarget,
  key: string,
  names?: readonly string[],
  sourceKinds?: readonly SkillSourceKind[],
  recoveryEpoch?: number
): Promise<SkillDiscoveryResult> {
  const generation = discoveryGeneration
  const normalizedTarget = normalizeSkillDiscoveryTarget(target, names, sourceKinds)
  // Forced post-mutation rechecks must bypass host scan sharing as well as window cache.
  const requestTarget = force ? { ...normalizedTarget, refresh: true } : normalizedTarget
  async function scan(): Promise<SkillDiscoveryResult> {
    for (;;) {
      try {
        return await discoverSkillsForRuntimeTarget(runtimeTarget, requestTarget)
      } catch (error) {
        if (!pending.retryOnFailure || pendingDiscoveryByTarget.get(key) !== pending) {
          throw error
        }
        // Consume one contact edge; every consumer keeps awaiting the same shared promise.
        pending.retryOnFailure = false
      }
    }
  }
  const pending: PendingDiscovery = {
    force,
    retryOnFailure: false,
    recoveryEpoch,
    promise: scan()
      .then((result) => {
        if (generation === discoveryGeneration && pendingDiscoveryByTarget.get(key) === pending) {
          writeInstalledAgentSkillDiscoveryCache(key, result)
        }
        return result
      })
      .finally(() => {
        if (pendingDiscoveryByTarget.get(key) === pending) {
          pendingDiscoveryByTarget.delete(key)
        }
      })
  }
  pendingDiscoveryByTarget.set(key, pending)
  return pending.promise
}

/** Share one pending scan per runtime-scoped key; force rereads disk. */
export async function discoverInstalledAgentSkills(
  force: boolean,
  target?: SkillDiscoveryTarget,
  runtimeTarget: RuntimeClientTarget = LOCAL_RUNTIME_TARGET,
  names?: readonly string[],
  sourceKinds?: readonly SkillSourceKind[],
  runtimeIdentity?: string,
  options: { recoveryEpoch?: number } = {}
): Promise<SkillDiscoveryResult> {
  const key = getRuntimeScopedSkillDiscoveryKey(
    runtimeTarget,
    target,
    names,
    sourceKinds,
    runtimeIdentity
  )
  if (!force) {
    // Contact recovery preserves successful evidence even after the focus freshness window.
    const cachedDiscovery =
      options.recoveryEpoch !== undefined
        ? peekInstalledAgentSkillDiscoveryCache(key)
        : readInstalledAgentSkillDiscoveryCache(key)
    if (cachedDiscovery) {
      return cachedDiscovery
    }
  }

  const inFlightDiscovery = pendingDiscoveryByTarget.get(key)
  if (inFlightDiscovery) {
    if (!force || inFlightDiscovery.force) {
      if (
        options.recoveryEpoch !== undefined &&
        options.recoveryEpoch !== inFlightDiscovery.recoveryEpoch
      ) {
        inFlightDiscovery.recoveryEpoch = options.recoveryEpoch
        inFlightDiscovery.retryOnFailure = true
      }
      return inFlightDiscovery.promise
    }
    try {
      await inFlightDiscovery.promise
    } catch {
      // Explicit rechecks still read disk after earlier background scan failure.
    }
    const nextPendingDiscovery = pendingDiscoveryByTarget.get(key)
    if (nextPendingDiscovery && nextPendingDiscovery !== inFlightDiscovery) {
      return nextPendingDiscovery.promise
    }
  }

  return startInstalledAgentSkillDiscovery(
    force,
    target,
    runtimeTarget,
    key,
    names,
    sourceKinds,
    options.recoveryEpoch
  )
}
