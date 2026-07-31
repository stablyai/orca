import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../../shared/skills'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { discoverSkillsForRuntimeTarget } from '@/runtime/runtime-skills-client'
import {
  INSTALLED_AGENT_SKILL_DISCOVERY_RUNTIME_REPLACED_EVENT,
  INSTALLED_AGENT_SKILLS_CHANGED_EVENT,
  type InstalledAgentSkillDiscoveryRuntimeReplacedDetail
} from './installed-agent-skills-change-event'
import {
  clearInstalledAgentSkillDiscoveryCache,
  evictInstalledAgentSkillDiscoveryCacheKey,
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

// Keyed eviction keeps surviving targets warm and this discovery module store-free.
export function evictSkillDiscoveryForRuntimeEnvironments(environmentIds: readonly string[]): void {
  for (const environmentId of environmentIds) {
    const key = getRuntimeScopedSkillDiscoveryKey({ kind: 'environment', environmentId }, undefined)
    evictInstalledAgentSkillDiscoveryCacheKey(key)
    pendingDiscoveryByTarget.delete(key)
    pendingDiscoverySatisfiesForcedRefreshByTarget.delete(key)
  }
}

export function notifySkillDiscoveryRuntimeEnvironmentsReplaced(
  environmentIds: readonly string[]
): void {
  if (
    environmentIds.length > 0 &&
    typeof window !== 'undefined' &&
    typeof window.dispatchEvent === 'function'
  ) {
    const keys = environmentIds.map((environmentId) =>
      getRuntimeScopedSkillDiscoveryKey({ kind: 'environment', environmentId }, undefined)
    )
    window.dispatchEvent(
      new CustomEvent<InstalledAgentSkillDiscoveryRuntimeReplacedDetail>(
        INSTALLED_AGENT_SKILL_DISCOVERY_RUNTIME_REPLACED_EVENT,
        { detail: { keys } }
      )
    )
  }
}

export function resetSkillDiscoveryCacheForTests(): void {
  invalidateInstalledAgentSkillDiscovery()
  resetInstalledAgentSkillDiscoveryCacheForTests()
  pendingDiscoveryByTarget = new Map()
  pendingDiscoverySatisfiesForcedRefreshByTarget = new Map()
}

function normalizeSkillDiscoveryTarget(
  target: SkillDiscoveryTarget | undefined
): SkillDiscoveryTarget | undefined {
  const projectRuntime = target?.projectRuntime
  if (projectRuntime) {
    if (projectRuntime.status === 'repair-required') {
      return { projectRuntime }
    }
    if (projectRuntime.runtime.kind === 'wsl') {
      return {
        runtime: 'wsl',
        wslDistro: projectRuntime.runtime.distro,
        projectRuntime
      }
    }
    return {
      runtime: 'host',
      projectRuntime
    }
  }

  if (target?.runtime !== 'wsl') {
    return undefined
  }
  return { runtime: 'wsl', wslDistro: target.wslDistro?.trim() || null }
}

export function getSkillDiscoveryTargetKey(target: SkillDiscoveryTarget | undefined): string {
  if (target?.projectRuntime) {
    return target.projectRuntime.status === 'resolved'
      ? target.projectRuntime.runtime.cacheKey
      : target.projectRuntime.repair.cacheKey
  }
  const normalizedTarget = normalizeSkillDiscoveryTarget(target)
  return normalizedTarget?.runtime === 'wsl' ? `wsl:${normalizedTarget.wslDistro ?? ''}` : 'host'
}

// Why: a connected remote runtime scans its own disk. Sharing the local key
// would keep showing the client's skills after switching environments. The
// caller's target is dropped for a remote scan (it describes the client's WSL /
// project runtime), so it must not fragment the key either — otherwise the same
// remote gets rescanned once per client-side target shape.
export function getRuntimeScopedSkillDiscoveryKey(
  runtimeTarget: RuntimeClientTarget,
  target: SkillDiscoveryTarget | undefined
): string {
  return runtimeTarget.kind === 'environment'
    ? `runtime:${runtimeTarget.environmentId}`
    : getSkillDiscoveryTargetKey(target)
}

function startInstalledAgentSkillDiscovery(
  force: boolean,
  target: SkillDiscoveryTarget | undefined,
  runtimeTarget: RuntimeClientTarget,
  key: string
): Promise<SkillDiscoveryResult> {
  const generation = discoveryGeneration
  const normalizedTarget = normalizeSkillDiscoveryTarget(target)
  const discovery = discoverSkillsForRuntimeTarget(runtimeTarget, normalizedTarget)
    .then((result) => {
      // Why: an evicted in-flight scan must not resurrect a retired entry.
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

/**
 * Cached, de-duplicated skill scan for one runtime. Concurrent callers share a
 * single in-flight scan per key; `force` bypasses the cache to re-read disk.
 */
export async function discoverInstalledAgentSkills(
  force: boolean,
  target?: SkillDiscoveryTarget,
  runtimeTarget: RuntimeClientTarget = LOCAL_RUNTIME_TARGET
): Promise<SkillDiscoveryResult> {
  const key = getRuntimeScopedSkillDiscoveryKey(runtimeTarget, target)
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

  return startInstalledAgentSkillDiscovery(force, target, runtimeTarget, key)
}
