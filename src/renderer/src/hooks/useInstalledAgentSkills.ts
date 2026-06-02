import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoveryTarget,
  SkillSourceKind
} from '../../../shared/skills'
import { ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import { markOrchestrationSetupComplete } from '@/lib/orchestration-setup-state'
import { useMountedRef } from './useMountedRef'

const INSTALLED_AGENT_SKILLS_CHANGED_EVENT = 'orca:installed-agent-skills-changed'
export const GLOBAL_AGENT_SKILL_SOURCE_KINDS = [
  'home'
] as const satisfies readonly SkillSourceKind[]

type InstalledAgentSkillOptions = {
  enabled?: boolean
  discoveryTarget?: SkillDiscoveryTarget
  sourceKinds?: readonly SkillSourceKind[]
}

type InstalledAgentSkillMatchOptions = {
  sourceKinds?: readonly SkillSourceKind[]
}

export type InstalledAgentSkillState = {
  installed: boolean
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

let cachedDiscoveryByTarget = new Map<string, SkillDiscoveryResult>()
let pendingDiscoveryByTarget = new Map<string, Promise<SkillDiscoveryResult>>()
let pendingDiscoverySatisfiesForcedRefreshByTarget = new Map<string, boolean>()

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase()
}

function isOrchestrationSkillName(skillName: string): boolean {
  return normalizeSkillName(skillName) === ORCHESTRATION_SKILL_NAME
}

function basenameFromPath(pathValue: string): string {
  return pathValue.split(/[\\/]/).filter(Boolean).at(-1) ?? pathValue
}

export function hasInstalledAgentSkill(
  skills: readonly DiscoveredSkill[],
  skillName: string,
  options: InstalledAgentSkillMatchOptions = {}
): boolean {
  const expected = normalizeSkillName(skillName)
  return skills.some((skill) => {
    if (!skill.installed) {
      return false
    }
    if (options.sourceKinds && !options.sourceKinds.includes(skill.sourceKind)) {
      return false
    }
    return (
      normalizeSkillName(skill.name) === expected ||
      normalizeSkillName(basenameFromPath(skill.directoryPath)) === expected
    )
  })
}

export function notifyInstalledAgentSkillsChanged(): void {
  cachedDiscoveryByTarget.clear()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(INSTALLED_AGENT_SKILLS_CHANGED_EVENT))
  }
}

function normalizeSkillDiscoveryTarget(
  target: SkillDiscoveryTarget | undefined
): SkillDiscoveryTarget | undefined {
  if (target?.runtime !== 'wsl') {
    return undefined
  }
  return { runtime: 'wsl', wslDistro: target.wslDistro?.trim() || null }
}

function getSkillDiscoveryTargetKey(target: SkillDiscoveryTarget | undefined): string {
  const normalizedTarget = normalizeSkillDiscoveryTarget(target)
  return normalizedTarget?.runtime === 'wsl' ? `wsl:${normalizedTarget.wslDistro ?? ''}` : 'host'
}

function startInstalledAgentSkillDiscovery(
  force: boolean,
  target: SkillDiscoveryTarget | undefined
): Promise<SkillDiscoveryResult> {
  const key = getSkillDiscoveryTargetKey(target)
  const normalizedTarget = normalizeSkillDiscoveryTarget(target)
  const discovery = window.api.skills
    .discover(normalizedTarget)
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

async function discoverInstalledAgentSkills(
  force: boolean,
  target?: SkillDiscoveryTarget
): Promise<SkillDiscoveryResult> {
  const key = getSkillDiscoveryTargetKey(target)
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

  return startInstalledAgentSkillDiscovery(force, target)
}

export const _installedAgentSkillDiscoveryInternalsForTests = {
  discoverInstalledAgentSkills,
  getSkillDiscoveryTargetKey,
  isOrchestrationSkillName,
  reset(): void {
    cachedDiscoveryByTarget = new Map()
    pendingDiscoveryByTarget = new Map()
    pendingDiscoverySatisfiesForcedRefreshByTarget = new Map()
  }
}

export function useInstalledAgentSkill(
  skillName: string,
  options: InstalledAgentSkillOptions = {}
): InstalledAgentSkillState {
  const { enabled = true, discoveryTarget, sourceKinds } = options
  const discoveryTargetKey = getSkillDiscoveryTargetKey(discoveryTarget)
  const cachedDiscovery = cachedDiscoveryByTarget.get(discoveryTargetKey) ?? null
  const [result, setResult] = useState<SkillDiscoveryResult | null>(cachedDiscovery)
  const [loading, setLoading] = useState(enabled && !cachedDiscovery)
  const [error, setError] = useState<string | null>(null)
  // Why: skill scans can outlive transient settings/onboarding panels; keep
  // the module cache update but skip React state writes after unmount.
  const mountedRef = useMountedRef()

  const refresh = useCallback(
    async (force = true): Promise<void> => {
      if (!enabled) {
        if (mountedRef.current) {
          setLoading(false)
        }
        return
      }
      if (mountedRef.current) {
        setLoading(true)
      }
      try {
        const next = await discoverInstalledAgentSkills(force, discoveryTarget)
        if (!mountedRef.current) {
          return
        }
        setResult(next)
        setError(null)
      } catch (refreshError) {
        if (!mountedRef.current) {
          return
        }
        setError(
          refreshError instanceof Error ? refreshError.message : 'Could not scan installed skills.'
        )
      } finally {
        if (mountedRef.current) {
          setLoading(false)
        }
      }
    },
    [discoveryTarget, enabled, mountedRef]
  )

  useEffect(() => {
    const nextCachedDiscovery = cachedDiscoveryByTarget.get(discoveryTargetKey) ?? null
    setResult(nextCachedDiscovery)
    setLoading(enabled && !nextCachedDiscovery)
  }, [discoveryTargetKey, enabled])

  useEffect(() => {
    void refresh(false)
  }, [refresh])

  useEffect(() => {
    if (!enabled) {
      return
    }
    const refreshFromExternalChange = (): void => {
      void refresh(true)
    }
    // Why: skill install commands run outside React state, often in a terminal.
    // Refresh on focus and explicit install events so completion is detected.
    window.addEventListener('focus', refreshFromExternalChange)
    window.addEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, refreshFromExternalChange)
    return () => {
      window.removeEventListener('focus', refreshFromExternalChange)
      window.removeEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, refreshFromExternalChange)
    }
  }, [enabled, refresh])

  const installed = useMemo(
    () =>
      enabled && result ? hasInstalledAgentSkill(result.skills, skillName, { sourceKinds }) : false,
    [enabled, result, skillName, sourceKinds]
  )

  useEffect(() => {
    if (installed && isOrchestrationSkillName(skillName)) {
      // Why: older floating-workspace education still keys off this marker; any
      // surface that detects the orchestration skill should satisfy setup.
      markOrchestrationSetupComplete()
    }
  }, [installed, skillName])

  const forceRefresh = useCallback(() => refresh(true), [refresh])

  return {
    installed,
    loading,
    error,
    refresh: forceRefresh
  }
}
