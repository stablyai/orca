import { useEffect, useState } from 'react'
import { useAppStore } from '../../store'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { onInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { createNativeChatSkillRequest } from './native-chat-skill-request'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

type NativeChatSkillWorktreeState = {
  tabsByWorktree: Record<string, readonly { id: string }[]>
  worktreesByRepo: Record<string, readonly { id: string; path: string }[]>
}

export function resolveNativeChatSkillDiscoveryCwd(
  state: NativeChatSkillWorktreeState,
  terminalTabId: string
): string | null {
  let ownerWorktreeId: string | null = null
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === terminalTabId)) {
      ownerWorktreeId = worktreeId
      break
    }
  }
  if (!ownerWorktreeId) {
    return null
  }
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    const worktree = worktrees.find((entry) => entry.id === ownerWorktreeId)
    if (worktree) {
      return worktree.path
    }
  }
  return null
}

export function useNativeChatSkills(
  agent: AgentType,
  terminalTabId: string,
  runtimeEnvironmentId: string | null = null
): DiscoveredSkill[] {
  const [skills, setSkills] = useState<DiscoveredSkill[]>([])
  const cwd = useAppStore((state) => resolveNativeChatSkillDiscoveryCwd(state, terminalTabId))

  useEffect(() => {
    if (agent !== 'codex' || !cwd) {
      setSkills([])
      return
    }
    const request = createNativeChatSkillRequest({
      cwd,
      list: (requestCwd, forceReload) =>
        runtimeEnvironmentId
          ? callRuntimeRpc<DiscoveredSkill[]>(
              { kind: 'environment', environmentId: runtimeEnvironmentId },
              'skills.codexList',
              { cwd: requestCwd, forceReload },
              { timeoutMs: 15_000 }
            )
          : window.api.skills.listCodex(requestCwd, forceReload),
      apply: setSkills
    })
    request.refresh()
    // Remote runtime inventory is queried on mount/lifecycle invalidation; local
    // app-server watcher notifications additionally hot-reload immediately.
    const unsubscribeCodex = runtimeEnvironmentId
      ? () => {}
      : window.api.skills.onCodexChanged(() => request.refresh())
    const unsubscribeLifecycle = onInstalledAgentSkillsChanged(() => request.refresh(true))
    return () => {
      request.cancel()
      unsubscribeCodex()
      unsubscribeLifecycle()
    }
  }, [agent, cwd, runtimeEnvironmentId])

  return skills
}
