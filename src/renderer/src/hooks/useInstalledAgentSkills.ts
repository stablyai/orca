import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoverySource,
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
import {
  INSTALLED_AGENT_SKILL_DISCOVERY_RUNTIME_REPLACED_EVENT,
  INSTALLED_AGENT_SKILLS_CHANGED_EVENT,
  INSTALLED_AGENT_SKILLS_REFRESHED_EVENT,
  type InstalledAgentSkillDiscoveryRuntimeReplacedDetail
} from './installed-agent-skills-change-event'
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
  // Why: a forced rescan keeps the previous result, so only the first scan per
  // runtime-scoped target is genuinely unknown.
  settled: boolean
  error: string | null
  skills: readonly DiscoveredSkill[]
  sources: readonly SkillDiscoverySource[]
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

export function notifyInstalledAgentSkillsRefreshed(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(INSTALLED_AGENT_SKILLS_REFRESHED_EVENT))
  }
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
  // Why: callers derive the target inside a store-backed useMemo, so unrelated
  // store writes hand us a new object with the same key. Two targets with the
  // same key resolve to the same scan, so hold one until the key moves and keep
  // `refresh` — and the discovery effect it drives — stable. State, not a ref:
  // React may discard a useMemo, and a render-phase ref write can leak from a
  // render that never commits.
  const [latchedDiscoveryTarget, setLatchedDiscoveryTarget] = useState({
    key: discoveryTargetKey,
    target: discoveryTarget
  })
  if (latchedDiscoveryTarget.key !== discoveryTargetKey) {
    setLatchedDiscoveryTarget({ key: discoveryTargetKey, target: discoveryTarget })
  }
  const stableDiscoveryTarget =
    latchedDiscoveryTarget.key === discoveryTargetKey
      ? latchedDiscoveryTarget.target
      : discoveryTarget
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
    async (force = true, showLoading = true): Promise<boolean> => {
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
      if (showLoading) {
        writeIfCurrent(() => {
          setLoading(true)
        })
      }
      if (!runtimeTarget) {
        // Why: stay in the loading state rather than scanning the wrong host and
        // reporting "not installed" before the owning runtime is known.
        return false
      }
      let installedAfterRefresh = false
      try {
        const next = await discoverInstalledAgentSkills(force, stableDiscoveryTarget, runtimeTarget)
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
        // Why: a silent refresh can supersede an in-flight loading one, whose own
        // clear is then dropped by the generation guard. Only the winning
        // generation clears, so it must clear regardless of its own showLoading.
        writeIfCurrent(() => {
          setLoading(false)
        })
      }
      return installedAfterRefresh
    },
    [
      candidateSkillNames,
      discoveryTargetKey,
      enabled,
      mountedRef,
      runtimeTarget,
      sourceKinds,
      stableDiscoveryTarget
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
    const refreshFromCompletedScan = (): void => {
      void refresh(false, false)
    }
    const refreshReplacedRuntime = (event: Event): void => {
      const { keys } = (event as CustomEvent<InstalledAgentSkillDiscoveryRuntimeReplacedDetail>)
        .detail
      if (keys.includes(discoveryTargetKey)) {
        void refresh(false)
      }
    }
    // Why: skill install commands run outside React state, often in a terminal.
    // Refresh on focus and explicit install events so completion is detected.
    window.addEventListener('focus', refreshFromExternalChange)
    window.addEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, refreshFromExternalChange)
    window.addEventListener(INSTALLED_AGENT_SKILLS_REFRESHED_EVENT, refreshFromCompletedScan)
    window.addEventListener(
      INSTALLED_AGENT_SKILL_DISCOVERY_RUNTIME_REPLACED_EVENT,
      refreshReplacedRuntime
    )
    return () => {
      window.removeEventListener('focus', refreshFromExternalChange)
      window.removeEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, refreshFromExternalChange)
      window.removeEventListener(INSTALLED_AGENT_SKILLS_REFRESHED_EVENT, refreshFromCompletedScan)
      window.removeEventListener(
        INSTALLED_AGENT_SKILL_DISCOVERY_RUNTIME_REPLACED_EVENT,
        refreshReplacedRuntime
      )
    }
  }, [discoveryTargetKey, enabled, refresh])

  const skills = useMemo(
    () => (enabled && resultForRender ? resultForRender.skills : []),
    [enabled, resultForRender]
  )
  const sources = useMemo(
    () => (enabled && resultForRender ? resultForRender.sources : []),
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
    settled: enabled && resultForRender !== null,
    error: errorForRender,
    skills,
    sources,
    refresh: forceRefresh
  }
}
