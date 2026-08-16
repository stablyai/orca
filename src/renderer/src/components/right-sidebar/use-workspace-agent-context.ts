import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentContextReport } from '../../../../shared/agent-context'
import type { DiscoveredSkill, SkillDiscoverySource } from '../../../../shared/skills'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { selectNativeChatSkillStateInputs } from '@/components/native-chat/native-chat-skill-discovery-context'
import { useMountedRef } from '@/hooks/useMountedRef'
import { inspectAgentContextForRuntimeTarget } from '@/runtime/runtime-agent-context-client'
import { discoverSkillsForRuntimeTarget } from '@/runtime/runtime-skills-client'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import {
  resolveWorkspaceContextTarget,
  resolveWorkspaceExecutionHostId
} from './workspace-context-target'

/** Why the panel has nothing to show even though a workspace is active. */
export type WorkspaceAgentContextUnavailable = 'ssh' | 'runtime-unresolved'

export type WorkspaceAgentContextState = {
  worktreeId: string | null
  worktreePath: string | null
  /** The host that runs the workspace's agents, where the report is read. */
  hostId: ExecutionHostId
  unavailable: WorkspaceAgentContextUnavailable | null
  report: AgentContextReport | null
  loading: boolean
  error: string | null
  skills: readonly DiscoveredSkill[]
  skillSources: readonly SkillDiscoverySource[]
  skillsLoading: boolean
  refresh: () => void
}

type Keyed<T> = { key: string; value: T }

function current<T>(keyed: Keyed<T> | null, key: string | null): T | null {
  return keyed && key !== null && keyed.key === key ? keyed.value : null
}

/**
 * Agent context (instruction files, MCP, hooks, plugins) plus discovered skills
 * for the active worktree, read on the host that runs its agents.
 */
export function useWorkspaceAgentContext(): WorkspaceAgentContextState {
  const worktree = useActiveWorktree()
  const worktreeId = worktree?.id ?? null
  const inputs = useAppStore(useShallow(selectNativeChatSkillStateInputs))
  const hostId = useMemo(
    () => resolveWorkspaceExecutionHostId(inputs, worktreeId),
    [inputs, worktreeId]
  )
  const target = useMemo(
    () => resolveWorkspaceContextTarget(inputs, worktreeId),
    [inputs, worktreeId]
  )
  const targetKey = target?.key ?? null
  const unavailable: WorkspaceAgentContextUnavailable | null =
    target?.executionHostKind === 'ssh'
      ? 'ssh'
      : worktreeId && !target
        ? 'runtime-unresolved'
        : null

  // Why: results are keyed to the target so a workspace switch never shows (or
  // opens files from) the previous workspace while the new scan is in flight.
  const [keyedReport, setKeyedReport] = useState<Keyed<AgentContextReport> | null>(null)
  const [keyedSkills, setKeyedSkills] = useState<Keyed<{
    skills: DiscoveredSkill[]
    sources: SkillDiscoverySource[]
  }> | null>(null)
  const [loading, setLoading] = useState(false)
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const mountedRef = useMountedRef()
  const latestKeyRef = useRef(targetKey)
  latestKeyRef.current = targetKey
  // Why: effects key on the serialised target; the live object travels by ref.
  const targetRef = useRef(target)
  targetRef.current = target

  useEffect(() => {
    const active = targetRef.current
    if (!active || active.executionHostKind === 'ssh') {
      setLoading(false)
      setSkillsLoading(false)
      setError(null)
      return
    }
    const requestKey = active.key
    const still = (): boolean => mountedRef.current && latestKeyRef.current === requestKey
    setLoading(true)
    setSkillsLoading(true)
    setError(null)
    void inspectAgentContextForRuntimeTarget(active.runtimeTarget, active.discoveryTarget)
      .then((next) => {
        if (still()) {
          setKeyedReport({ key: requestKey, value: next })
        }
      })
      .catch((cause: unknown) => {
        if (still()) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        if (still()) {
          setLoading(false)
        }
      })
    void discoverSkillsForRuntimeTarget(active.runtimeTarget, {
      ...active.discoveryTarget,
      refresh: generation > 0
    })
      .then((next) => {
        if (still()) {
          setKeyedSkills({ key: requestKey, value: { skills: next.skills, sources: next.sources } })
        }
      })
      .catch(() => {
        // Why: the report is still useful without skills; the section shows empty.
      })
      .finally(() => {
        if (still()) {
          setSkillsLoading(false)
        }
      })
  }, [targetKey, generation, mountedRef])

  const refresh = useCallback(() => setGeneration((value) => value + 1), [])
  const skillResult = current(keyedSkills, targetKey)

  return {
    worktreeId,
    worktreePath: target?.cwd ?? worktree?.path ?? null,
    hostId,
    unavailable,
    report: current(keyedReport, targetKey),
    loading,
    error,
    skills: skillResult?.skills ?? [],
    skillSources: skillResult?.sources ?? [],
    skillsLoading,
    refresh
  }
}
