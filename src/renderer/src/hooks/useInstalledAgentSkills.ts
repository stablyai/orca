import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../shared/skills'

const INSTALLED_AGENT_SKILLS_CHANGED_EVENT = 'orca:installed-agent-skills-changed'

let cachedDiscovery: SkillDiscoveryResult | null = null
let pendingDiscovery: Promise<SkillDiscoveryResult> | null = null

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase()
}

function basenameFromPath(pathValue: string): string {
  return pathValue.split(/[\\/]/).filter(Boolean).at(-1) ?? pathValue
}

export function hasInstalledAgentSkill(
  skills: readonly DiscoveredSkill[],
  skillName: string
): boolean {
  const expected = normalizeSkillName(skillName)
  return skills.some((skill) => {
    if (!skill.installed) {
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

async function discoverInstalledAgentSkills(force: boolean): Promise<SkillDiscoveryResult> {
  if (pendingDiscovery) {
    return pendingDiscovery
  }
  if (!force && cachedDiscovery) {
    return cachedDiscovery
  }

  pendingDiscovery = window.api.skills.discover()
  try {
    cachedDiscovery = await pendingDiscovery
    return cachedDiscovery
  } finally {
    pendingDiscovery = null
  }
}

export function useInstalledAgentSkill(
  skillName: string,
  options: { enabled?: boolean } = {}
): {
  installed: boolean
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
} {
  const { enabled = true } = options
  const [result, setResult] = useState<SkillDiscoveryResult | null>(cachedDiscovery)
  const [loading, setLoading] = useState(enabled && !cachedDiscovery)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(
    async (force = true): Promise<void> => {
      if (!enabled) {
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        const next = await discoverInstalledAgentSkills(force)
        setResult(next)
        setError(null)
      } catch (refreshError) {
        setError(
          refreshError instanceof Error ? refreshError.message : 'Could not scan installed skills.'
        )
      } finally {
        setLoading(false)
      }
    },
    [enabled]
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
    () => (result ? hasInstalledAgentSkill(result.skills, skillName) : false),
    [result, skillName]
  )

  const forceRefresh = useCallback(() => refresh(true), [refresh])

  return {
    installed,
    loading,
    error,
    refresh: forceRefresh
  }
}
