import type {
  SkillDiscoveryResult,
  SkillDiscoveryTarget,
  SkillSourceKind
} from '../../../shared/skills'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { discoverSkillsForRuntimeTarget } from '@/runtime/runtime-skills-client'
import { INSTALLED_AGENT_SKILLS_CHANGED_EVENT } from './installed-agent-skills-change-event'
import {
  clearInstalledAgentSkillDiscoveryCache,
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
  // Why: an install/uninstall must start a post-mutation scan; older pending
  // reads may finish, but their generation can no longer repopulate the cache.
  pendingDiscoveryByTarget.clear()
  pendingDiscoverySatisfiesForcedRefreshByTarget.clear()
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
  const effectiveNames = names ?? target?.names
  const effectiveSourceKinds = sourceKinds ?? target?.sourceKinds
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

export function getSkillDiscoveryTargetKey(
  target: SkillDiscoveryTarget | undefined,
  names?: readonly string[],
  sourceKinds?: readonly SkillSourceKind[]
): string {
  if (target?.projectRuntime) {
    return target.projectRuntime.status === 'resolved'
      ? target.projectRuntime.runtime.cacheKey
      : target.projectRuntime.repair.cacheKey
  }
  const normalizedTarget = normalizeSkillDiscoveryTarget(target, names, sourceKinds)
  const runtimeKey =
    normalizedTarget?.runtime === 'wsl' ? `wsl:${normalizedTarget.wslDistro ?? ''}` : 'host'
  return normalizedTarget?.names?.length || normalizedTarget?.sourceKinds?.length
    ? JSON.stringify([
        runtimeKey,
        normalizedTarget.names ?? null,
        normalizedTarget.sourceKinds ?? null
      ])
    : runtimeKey
}

// Why: a connected remote runtime scans its own disk. Sharing the local key
// would keep showing the client's skills after switching environments. The
// caller's target is dropped for a remote scan (it describes the client's WSL /
// project runtime), so it must not fragment the key either — otherwise the same
// remote gets rescanned once per client-side target shape.
export function getRuntimeScopedSkillDiscoveryKey(
  runtimeTarget: RuntimeClientTarget,
  target: SkillDiscoveryTarget | undefined,
  names?: readonly string[],
  sourceKinds?: readonly SkillSourceKind[]
): string {
  const runtimeKey =
    runtimeTarget.kind === 'environment'
      ? `runtime:${runtimeTarget.environmentId}`
      : getSkillDiscoveryTargetKey(target)
  return names?.length || sourceKinds?.length
    ? JSON.stringify([runtimeKey, names ?? null, sourceKinds ?? null])
    : runtimeKey
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
  // Why: a forced caller knows disk changed (install finished, explicit recheck),
  // so it must also bypass the host's shared scans — not just this window's cache.
  const requestTarget = force ? { ...normalizedTarget, refresh: true } : normalizedTarget
  const discovery = discoverSkillsForRuntimeTarget(runtimeTarget, requestTarget)
    .then((result) => {
      if (generation === discoveryGeneration) {
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

/**
 * Cached, de-duplicated skill scan for one runtime. Concurrent callers share a
 * single in-flight scan per key; `force` bypasses the cache to re-read disk.
 */
export async function discoverInstalledAgentSkills(
  force: boolean,
  target?: SkillDiscoveryTarget,
  runtimeTarget: RuntimeClientTarget = LOCAL_RUNTIME_TARGET,
  names?: readonly string[],
  sourceKinds?: readonly SkillSourceKind[]
): Promise<SkillDiscoveryResult> {
  const key = getRuntimeScopedSkillDiscoveryKey(runtimeTarget, target, names, sourceKinds)
  if (!force) {
    // Why: only a cache-serving read should refresh recency — a forced refresh
    // discards the entry it would otherwise promote.
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
      // Why: an explicit re-check should still read current disk state even if
      // the older background scan failed.
    }
    const nextPendingDiscovery = pendingDiscoveryByTarget.get(key)
    if (nextPendingDiscovery && nextPendingDiscovery !== inFlightDiscovery) {
      return nextPendingDiscovery
    }
  }

  return startInstalledAgentSkillDiscovery(force, target, runtimeTarget, key, names, sourceKinds)
}
