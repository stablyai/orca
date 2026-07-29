import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoveryTarget,
  SkillSourceKind
} from '../../../shared/skills'
import { ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import { markOrchestrationSetupComplete } from '@/lib/orchestration-setup-state'
import {
  discoverInstalledAgentSkills,
  getCachedSkillDiscovery,
  getRuntimeScopedSkillDiscoveryKey,
  getSkillDiscoveryTargetKey,
  resetSkillDiscoveryCacheForTests
} from './installed-agent-skill-discovery'
import { INSTALLED_AGENT_SKILLS_CHANGED_EVENT } from './installed-agent-skills-change-event'
import { useActiveSkillDiscoveryRuntimeTarget } from './use-active-skill-discovery-runtime-target'
import { useMountedRef } from './useMountedRef'

/** Placeholder key while the owning runtime is unknown; nothing is cached under it. */
const UNRESOLVED_RUNTIME_DISCOVERY_KEY = 'runtime:unresolved'

export { notifyInstalledAgentSkillsChanged } from './installed-agent-skill-discovery'

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
  skills: readonly DiscoveredSkill[]
  refresh: () => Promise<boolean>
}

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase()
}

function isOrchestrationSkillName(skillName: string): boolean {
  return normalizeSkillName(skillName) === ORCHESTRATION_SKILL_NAME
}

function basenameFromPath(pathValue: string): string {
  return pathValue.split(/[\\/]/).findLast(Boolean) ?? pathValue
}

export function hasInstalledAgentSkill(
  skills: readonly DiscoveredSkill[],
  skillName: string,
  options: InstalledAgentSkillMatchOptions = {}
): boolean {
  return hasInstalledAgentSkillNamed(skills, [skillName], options)
}

export function hasInstalledAgentSkillNamed(
  skills: readonly DiscoveredSkill[],
  skillNames: readonly string[],
  options: InstalledAgentSkillMatchOptions = {}
): boolean {
  const expected = new Set(skillNames.map(normalizeSkillName))
  return skills.some((skill) => {
    if (!skill.installed) {
      return false
    }
    if (options.sourceKinds && !options.sourceKinds.includes(skill.sourceKind)) {
      return false
    }
    return (
      expected.has(normalizeSkillName(skill.name)) ||
      expected.has(normalizeSkillName(basenameFromPath(skill.directoryPath)))
    )
  })
}

export const _installedAgentSkillDiscoveryInternalsForTests = {
  discoverInstalledAgentSkills,
  getSkillDiscoveryTargetKey,
  isOrchestrationSkillName,
  reset: resetSkillDiscoveryCacheForTests
}

export function useInstalledAgentSkill(
  skillName: string,
  options: InstalledAgentSkillOptions = {}
): InstalledAgentSkillState {
  return useInstalledAgentSkillNames([skillName], options)
}

export function useInstalledAgentSkillNames(
  skillNames: readonly string[],
  options: InstalledAgentSkillOptions = {}
): InstalledAgentSkillState {
  const { enabled = true, discoveryTarget, sourceKinds } = options
  const skillNamesKey = skillNames.map(normalizeSkillName).join('\n')
  const candidateSkillNames = useMemo(() => skillNamesKey.split('\n'), [skillNamesKey])
  const runtimeTarget = useActiveSkillDiscoveryRuntimeTarget()
  const discoveryTargetKey = runtimeTarget
    ? getRuntimeScopedSkillDiscoveryKey(runtimeTarget, discoveryTarget)
    : UNRESOLVED_RUNTIME_DISCOVERY_KEY
  const cachedDiscovery = getCachedSkillDiscovery(discoveryTargetKey)
  const [result, setResult] = useState<SkillDiscoveryResult | null>(cachedDiscovery)
  const [loading, setLoading] = useState(enabled && !cachedDiscovery)
  const [error, setError] = useState<string | null>(null)
  const currentDiscoveryTargetKeyRef = useRef(discoveryTargetKey)
  const refreshGenerationRef = useRef(0)
  const stateResetInputRef = useRef({ discoveryTargetKey, enabled })
  currentDiscoveryTargetKeyRef.current = discoveryTargetKey
  // Why: skill scans can outlive transient settings/onboarding panels; keep
  // the module cache update but skip React state writes after unmount.
  const mountedRef = useMountedRef()
  let resultForRender = result
  let loadingForRender = loading
  let errorForRender = error
  if (
    stateResetInputRef.current.discoveryTargetKey !== discoveryTargetKey ||
    stateResetInputRef.current.enabled !== enabled
  ) {
    const nextCachedDiscovery = getCachedSkillDiscovery(discoveryTargetKey)
    const nextLoading = enabled && !nextCachedDiscovery
    stateResetInputRef.current = { discoveryTargetKey, enabled }
    resultForRender = nextCachedDiscovery
    loadingForRender = nextLoading
    errorForRender = null
    setResult(nextCachedDiscovery)
    setLoading(nextLoading)
    setError(null)
  }

  const refresh = useCallback(
    async (force = true): Promise<boolean> => {
      const requestDiscoveryTargetKey = discoveryTargetKey
      const requestGeneration = ++refreshGenerationRef.current
      const writeIfCurrent = (write: () => void): void => {
        if (
          mountedRef.current &&
          requestGeneration === refreshGenerationRef.current &&
          currentDiscoveryTargetKeyRef.current === requestDiscoveryTargetKey
        ) {
          write()
        }
      }

      if (!enabled) {
        writeIfCurrent(() => {
          setLoading(false)
        })
        return false
      }
      writeIfCurrent(() => {
        setLoading(true)
      })
      if (!runtimeTarget) {
        // Why: stay in the loading state rather than scanning the wrong host and
        // reporting "not installed" before the owning runtime is known.
        return false
      }
      let installedAfterRefresh = false
      try {
        const next = await discoverInstalledAgentSkills(force, discoveryTarget, runtimeTarget)
        installedAfterRefresh = hasInstalledAgentSkillNamed(next.skills, candidateSkillNames, {
          sourceKinds
        })
        writeIfCurrent(() => {
          setResult(next)
          setError(null)
        })
      } catch (refreshError) {
        writeIfCurrent(() => {
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : 'Could not scan installed skills.'
          )
        })
      } finally {
        writeIfCurrent(() => {
          setLoading(false)
        })
      }
      return installedAfterRefresh
    },
    [
      candidateSkillNames,
      discoveryTarget,
      discoveryTargetKey,
      enabled,
      mountedRef,
      runtimeTarget,
      sourceKinds
    ]
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

  const skills = useMemo(
    () => (enabled && resultForRender ? resultForRender.skills : []),
    [enabled, resultForRender]
  )

  const installed = useMemo(
    () =>
      enabled ? hasInstalledAgentSkillNamed(skills, candidateSkillNames, { sourceKinds }) : false,
    [candidateSkillNames, enabled, skills, sourceKinds]
  )

  useEffect(() => {
    if (installed && candidateSkillNames.some(isOrchestrationSkillName)) {
      // Why: older floating-workspace education still keys off this marker; any
      // surface that detects the orchestration skill should satisfy setup.
      markOrchestrationSetupComplete()
    }
  }, [candidateSkillNames, installed])

  const forceRefresh = useCallback(() => refresh(true), [refresh])

  return {
    installed,
    loading: loadingForRender,
    error: errorForRender,
    skills,
    refresh: forceRefresh
  }
}
