import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DiscoveredSkill, SkillDiscoveryResult, SkillSourceKind } from '../../../shared/skills'
import { useMountedRef } from './useMountedRef'

const INSTALLED_AGENT_SKILLS_CHANGED_EVENT = 'orca:installed-agent-skills-changed'
export const GLOBAL_AGENT_SKILL_SOURCE_KINDS = [
  'home'
] as const satisfies readonly SkillSourceKind[]

type InstalledAgentSkillOptions = {
  enabled?: boolean
  sourceKinds?: readonly SkillSourceKind[]
}

type InstalledAgentSkillMatchOptions = {
  sourceKinds?: readonly SkillSourceKind[]
}

let cachedDiscovery: SkillDiscoveryResult | null = null
let pendingDiscovery: Promise<SkillDiscoveryResult> | null = null
let pendingDiscoverySatisfiesForcedRefresh = false

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase()
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
  cachedDiscovery = null
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(INSTALLED_AGENT_SKILLS_CHANGED_EVENT))
  }
}

function startInstalledAgentSkillDiscovery(force: boolean): Promise<SkillDiscoveryResult> {
  const discovery = window.api.skills
    .discover()
    .then((result) => {
      cachedDiscovery = result
      return result
    })
    .finally(() => {
      if (pendingDiscovery === discovery) {
        pendingDiscovery = null
        pendingDiscoverySatisfiesForcedRefresh = false
      }
    })
  pendingDiscovery = discovery
  pendingDiscoverySatisfiesForcedRefresh = force
  return discovery
}

async function discoverInstalledAgentSkills(force: boolean): Promise<SkillDiscoveryResult> {
  if (!force && cachedDiscovery) {
    return cachedDiscovery
  }

  const inFlightDiscovery = pendingDiscovery
  if (inFlightDiscovery) {
    if (!force || pendingDiscoverySatisfiesForcedRefresh) {
      return inFlightDiscovery
    }
    try {
      await inFlightDiscovery
    } catch {
      // Why: an explicit re-check should still read current disk state even if
      // the older background scan failed.
    }
    if (pendingDiscovery && pendingDiscovery !== inFlightDiscovery) {
      return pendingDiscovery
    }
  }

  return startInstalledAgentSkillDiscovery(force)
}

export const _installedAgentSkillDiscoveryInternalsForTests = {
  discoverInstalledAgentSkills,
  reset(): void {
    cachedDiscovery = null
    pendingDiscovery = null
    pendingDiscoverySatisfiesForcedRefresh = false
  }
}

export function useInstalledAgentSkill(
  skillName: string,
  options: InstalledAgentSkillOptions = {}
): {
  installed: boolean
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
} {
  const { enabled = true, sourceKinds } = options
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
        const next = await discoverInstalledAgentSkills(force)
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
    [enabled, mountedRef]
  )

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

  const forceRefresh = useCallback(() => refresh(true), [refresh])

  return {
    installed,
    loading,
    error,
    refresh: forceRefresh
  }
}
