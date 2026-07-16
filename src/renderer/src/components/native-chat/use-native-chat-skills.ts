import { useEffect, useState } from 'react'
import { useAppStore } from '../../store'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { onInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { createNativeChatSkillRequest } from './native-chat-skill-request'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { selectNativeChatRuntimeEnvironmentId } from './native-chat-runtime-owner'

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
  paneKey: string
): DiscoveredSkill[] {
  const [skills, setSkills] = useState<DiscoveredSkill[]>([])
  const cwd = useAppStore((state) => resolveNativeChatSkillDiscoveryCwd(state, terminalTabId))
  const runtimeEnvironmentId = useAppStore((state) =>
    selectNativeChatRuntimeEnvironmentId(state, terminalTabId)
  )
  const codexHome = useAppStore(
    (state) => state.agentLaunchConfigByPaneKey[paneKey]?.launchConfig.agentEnv.CODEX_HOME
  )

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
              { cwd: requestCwd, forceReload, codexHome },
              { timeoutMs: 15_000 }
            )
          : window.api.skills.listCodex(requestCwd, forceReload, codexHome),
      apply: setSkills
    })
    request.refresh()
    let unsubscribeCodex = window.api.skills.onCodexChanged(() => request.refresh())
    if (runtimeEnvironmentId) {
      unsubscribeCodex()
      let cancelled = false
      let closeRemote = (): void => {}
      void window.api.runtimeEnvironments
        .subscribe(
          {
            selector: runtimeEnvironmentId,
            method: 'skills.codexSubscribe',
            params: {},
            timeoutMs: 15_000
          },
          {
            onResponse: (response) => {
              if (
                !cancelled &&
                response.ok &&
                (response.result as { type?: string })?.type === 'changed'
              ) {
                request.refresh()
              }
            }
          }
        )
        .then((handle) => {
          if (cancelled) {
            handle.unsubscribe()
          } else {
            closeRemote = handle.unsubscribe
          }
        })
      unsubscribeCodex = () => {
        cancelled = true
        closeRemote()
      }
    }
    const unsubscribeLifecycle = onInstalledAgentSkillsChanged(() => request.refresh(true))
    return () => {
      request.cancel()
      unsubscribeCodex()
      unsubscribeLifecycle()
    }
  }, [agent, codexHome, cwd, runtimeEnvironmentId])

  return skills
}
