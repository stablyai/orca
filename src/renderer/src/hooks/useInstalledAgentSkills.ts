import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoveryTarget,
  SkillSourceKind
} from '../../../shared/skills'
import { ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import { markOrchestrationSetupComplete } from '@/lib/orchestration-setup-state'
import { INSTALLED_AGENT_SKILLS_CHANGED_EVENT } from './installed-agent-skills-change-event'
import { useMountedRef } from './useMountedRef'
import { InstalledSkillDiscoveryCoordinator } from './installed-skill-discovery-coordinator'

export {
  MAX_CACHED_SKILL_DISCOVERY_TARGETS,
  MAX_PENDING_SKILL_DISCOVERY_TARGETS
} from './installed-skill-discovery-cache'

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

let skillDiscoveryCoordinator = new InstalledSkillDiscoveryCoordinator()

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

export function notifyInstalledAgentSkillsChanged(): void {
  skillDiscoveryCoordinator.clearCache()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(INSTALLED_AGENT_SKILLS_CHANGED_EVENT))
  }
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

function getSkillDiscoveryTargetKey(target: SkillDiscoveryTarget | undefined): string {
  if (target?.projectRuntime) {
    return target.projectRuntime.status === 'resolved'
      ? target.projectRuntime.runtime.cacheKey
      : target.projectRuntime.repair.cacheKey
  }
  const normalizedTarget = normalizeSkillDiscoveryTarget(target)
  return normalizedTarget?.runtime === 'wsl' ? `wsl:${normalizedTarget.wslDistro ?? ''}` : 'host'
}

function discoverInstalledAgentSkills(
  force: boolean,
  target?: SkillDiscoveryTarget
): Promise<SkillDiscoveryResult> {
  const key = getSkillDiscoveryTargetKey(target)
  const normalizedTarget = normalizeSkillDiscoveryTarget(target)
  return skillDiscoveryCoordinator.discover({
    force,
    key,
    run: () => window.api.skills.discover(normalizedTarget)
  })
}

export const _installedAgentSkillDiscoveryInternalsForTests = {
  discoverInstalledAgentSkills,
  getSkillDiscoveryTargetKey,
  isOrchestrationSkillName,
  cacheSizes: () => skillDiscoveryCoordinator.sizes(),
  reset(): void {
    skillDiscoveryCoordinator = new InstalledSkillDiscoveryCoordinator()
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
  const discoveryTargetKey = getSkillDiscoveryTargetKey(discoveryTarget)
  const cachedDiscovery = skillDiscoveryCoordinator.getCached(discoveryTargetKey) ?? null
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
    const nextCachedDiscovery = skillDiscoveryCoordinator.getCached(discoveryTargetKey) ?? null
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
      let installedAfterRefresh = false
      try {
        const next = await discoverInstalledAgentSkills(force, discoveryTarget)
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
    [candidateSkillNames, discoveryTarget, discoveryTargetKey, enabled, mountedRef, sourceKinds]
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
