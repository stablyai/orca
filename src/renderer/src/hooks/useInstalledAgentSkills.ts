import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoverySource,
  SkillDiscoveryTarget,
  SkillSourceKind
} from '../../../shared/skills'
import { ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-skill-names'
import { markOrchestrationSetupComplete } from '@/lib/orchestration-setup-state'
import {
  discoverInstalledAgentSkills,
  getCachedSkillDiscovery,
  getRuntimeScopedSkillDiscoveryKey
} from './installed-agent-skill-discovery'
import {
  getInstalledAgentSkillVerdict,
  type InstalledAgentSkillScan
} from './installed-agent-skill-verdict'
import {
  INSTALLED_AGENT_SKILLS_CHANGED_EVENT,
  INSTALLED_AGENT_SKILLS_REFRESHED_EVENT
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
  runtimeTarget?: RuntimeClientTarget | null
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
  // Only first results are unknown; forced rescans retain prior evidence.
  settled: boolean
  // A negative this scan cannot vouch for: render it as unknown, not as undone.
  installedUnverifiable: boolean
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
  const activeRuntimeTarget = useActiveSkillDiscoveryRuntimeTarget()
  const runtimeTarget =
    options.runtimeTarget === undefined ? activeRuntimeTarget : options.runtimeTarget
  const discoveryTargetKey = runtimeTarget
    ? getRuntimeScopedSkillDiscoveryKey(
        runtimeTarget,
        discoveryTarget,
        candidateSkillNames,
        sourceKinds
      )
    : UNRESOLVED_RUNTIME_DISCOVERY_KEY
  // Hold equivalent target keys in React state to stabilize refresh/effects; memo discard and render-phase ref writes must not leak across uncommitted renders.
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
  // Reset with peer/key changes in state; render-phase ref writes survive discarded renders and could retain the retired peer’s list.
  const [stateResetInput, setStateResetInput] = useState({
    discoveryTargetKey,
    enabled,
    runtimeTarget
  })
  currentDiscoveryTargetKeyRef.current = discoveryTargetKey
  // Let late scans update module cache, but never set React state after transient surfaces unmount.
  const mountedRef = useMountedRef()
  let resultForRender = result
  let loadingForRender = loading
  let errorForRender = error
  if (
    stateResetInput.discoveryTargetKey !== discoveryTargetKey ||
    stateResetInput.enabled !== enabled ||
    stateResetInput.runtimeTarget !== runtimeTarget
  ) {
    const nextCachedDiscovery = getCachedSkillDiscovery(discoveryTargetKey)
    const nextLoading = enabled && !nextCachedDiscovery
    setStateResetInput({ discoveryTargetKey, enabled, runtimeTarget })
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
        // Wait for owner resolution instead of scanning the wrong host and claiming absent skills.
        return false
      }
      let installedAfterRefresh = false
      try {
        const next = await discoverInstalledAgentSkills(
          force,
          stableDiscoveryTarget,
          runtimeTarget,
          candidateSkillNames,
          sourceKinds
        )
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
        // Only the winning generation clears loading, even when a silent refresh supersedes a visible scan.
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
    // Installs occur outside React; mutation events force past every cache.
    const refreshFromInstall = (): void => {
      void refresh(true)
    }
    // Focus/other-surface refresh are freshness hints, not mutations; forcing them would disk-scan every window/client on each app switch.
    const refreshQuietly = (): void => {
      void refresh(false, false)
    }
    window.addEventListener('focus', refreshQuietly)
    window.addEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, refreshFromInstall)
    window.addEventListener(INSTALLED_AGENT_SKILLS_REFRESHED_EVENT, refreshQuietly)
    return () => {
      window.removeEventListener('focus', refreshQuietly)
      window.removeEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, refreshFromInstall)
      window.removeEventListener(INSTALLED_AGENT_SKILLS_REFRESHED_EVENT, refreshQuietly)
    }
  }, [enabled, refresh])

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

  const settled = enabled && resultForRender !== null
  const scan: InstalledAgentSkillScan = {
    enabled,
    installed,
    settled,
    error: errorForRender,
    sources,
    sourceKinds
  }

  useEffect(() => {
    if (installed && candidateSkillNames.some(isOrchestrationSkillName)) {
      // Legacy floating-workspace setup still reads this orchestration-skill marker.
      markOrchestrationSetupComplete()
    }
  }, [candidateSkillNames, installed])

  const forceRefresh = useCallback(() => refresh(true), [refresh])

  return {
    installed,
    loading: loadingForRender,
    settled,
    ...getInstalledAgentSkillVerdict(scan),
    skills,
    sources,
    refresh: forceRefresh
  }
}
