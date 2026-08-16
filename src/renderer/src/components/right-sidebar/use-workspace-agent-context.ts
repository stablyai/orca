import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentContextReport } from '../../../../shared/agent-context'
import type {
  DiscoveredSkill,
  SkillDiscoverySource,
  SkillDiscoveryTarget
} from '../../../../shared/skills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { useActiveSkillDiscoveryRuntimeTarget } from '@/hooks/use-active-skill-discovery-runtime-target'
import { useInstalledAgentSkillNames } from '@/hooks/useInstalledAgentSkills'
import { useMountedRef } from '@/hooks/useMountedRef'
import { inspectAgentContextForRuntimeTarget } from '@/runtime/runtime-agent-context-client'
import { useActiveWorktree } from '@/store/selectors'

export type WorkspaceAgentContextState = {
  worktreeId: string | null
  worktreePath: string | null
  report: AgentContextReport | null
  loading: boolean
  error: string | null
  skills: readonly DiscoveredSkill[]
  skillSources: readonly SkillDiscoverySource[]
  skillsLoading: boolean
  refresh: () => void
}

/**
 * Agent context (instruction files, MCP, hooks, plugins) plus discovered skills
 * for the active worktree, read on the host that runs its agents.
 */
export function useWorkspaceAgentContext(): WorkspaceAgentContextState {
  const worktree = useActiveWorktree()
  const worktreeId = worktree?.id ?? null
  const worktreePath = worktree?.path ?? null
  const runtimeTarget = useActiveSkillDiscoveryRuntimeTarget()
  const { discoveryTarget: projectDiscoveryTarget } = useActiveProjectSkillRuntime()

  const discoveryTarget = useMemo<SkillDiscoveryTarget | undefined>(
    () =>
      worktreePath
        ? { ...projectDiscoveryTarget, cwd: worktreePath, worktreeId: worktreeId ?? undefined }
        : undefined,
    [projectDiscoveryTarget, worktreeId, worktreePath]
  )
  // Why: the target's identity churns with store writes; key effects on content.
  const discoveryTargetKey = JSON.stringify([runtimeTarget, discoveryTarget])

  const skillState = useInstalledAgentSkillNames([], {
    enabled: Boolean(discoveryTarget),
    discoveryTarget
  })

  // Why: keyed to the target so a workspace switch never shows (or opens files
  // from) the previous workspace's report while the new scan is in flight.
  const [keyedReport, setKeyedReport] = useState<{
    key: string
    report: AgentContextReport
  } | null>(null)
  const report = keyedReport?.key === discoveryTargetKey ? keyedReport.report : null
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const mountedRef = useMountedRef()
  const latestKeyRef = useRef(discoveryTargetKey)
  latestKeyRef.current = discoveryTargetKey
  // Why: the effect keys on the serialised target, so the live objects travel
  // by ref instead of being (unstable) dependencies.
  const targetsRef = useRef({ runtimeTarget, discoveryTarget })
  targetsRef.current = { runtimeTarget, discoveryTarget }

  useEffect(() => {
    const { runtimeTarget, discoveryTarget } = targetsRef.current
    if (!runtimeTarget || !discoveryTarget) {
      setKeyedReport(null)
      setLoading(false)
      setError(null)
      return
    }
    const requestKey = discoveryTargetKey
    setLoading(true)
    setError(null)
    void inspectAgentContextForRuntimeTarget(runtimeTarget, discoveryTarget)
      .then((next) => {
        if (mountedRef.current && latestKeyRef.current === requestKey) {
          setKeyedReport({ key: requestKey, report: next })
        }
      })
      .catch((cause: unknown) => {
        if (mountedRef.current && latestKeyRef.current === requestKey) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        if (mountedRef.current && latestKeyRef.current === requestKey) {
          setLoading(false)
        }
      })
  }, [discoveryTargetKey, generation, mountedRef])

  const refreshSkills = skillState.refresh
  const refresh = useCallback(() => {
    setGeneration((current) => current + 1)
    void refreshSkills()
  }, [refreshSkills])

  return {
    worktreeId,
    worktreePath,
    report,
    loading,
    error,
    skills: skillState.skills,
    skillSources: skillState.sources,
    skillsLoading: skillState.loading,
    refresh
  }
}
