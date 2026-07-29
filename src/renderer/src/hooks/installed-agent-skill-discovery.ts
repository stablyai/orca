import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../../shared/skills'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { discoverSkillsForRuntimeTarget } from '@/runtime/runtime-skills-client'
import { INSTALLED_AGENT_SKILLS_CHANGED_EVENT } from './installed-agent-skills-change-event'

export const LOCAL_RUNTIME_TARGET: RuntimeClientTarget = { kind: 'local' }

let cachedDiscoveryByTarget = new Map<string, SkillDiscoveryResult>()
let pendingDiscoveryByTarget = new Map<string, Promise<SkillDiscoveryResult>>()
let pendingDiscoverySatisfiesForcedRefreshByTarget = new Map<string, boolean>()

/** Last completed scan for a runtime-scoped key, for a synchronous first render. */
export function getCachedSkillDiscovery(key: string): SkillDiscoveryResult | null {
  return cachedDiscoveryByTarget.get(key) ?? null
}

/** Invalidate every cached scan and tell mounted hooks to re-scan (e.g. after an install). */
export function notifyInstalledAgentSkillsChanged(): void {
  cachedDiscoveryByTarget.clear()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(INSTALLED_AGENT_SKILLS_CHANGED_EVENT))
  }
}

export function resetSkillDiscoveryCacheForTests(): void {
  cachedDiscoveryByTarget = new Map()
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
  runtimeTarget: RuntimeClientTarget
): Promise<SkillDiscoveryResult> {
  const key = getRuntimeScopedSkillDiscoveryKey(runtimeTarget, target)
  const normalizedTarget = normalizeSkillDiscoveryTarget(target)
  const discovery = discoverSkillsForRuntimeTarget(runtimeTarget, normalizedTarget)
    .then((result) => {
      cachedDiscoveryByTarget.set(key, result)
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
  const cachedDiscovery = cachedDiscoveryByTarget.get(key)
  if (!force && cachedDiscovery) {
    return cachedDiscovery
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

  return startInstalledAgentSkillDiscovery(force, target, runtimeTarget)
}
