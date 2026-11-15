import { useShallow } from 'zustand/react/shallow'
import { useCallback, useSyncExternalStore } from 'react'
import type { DashboardAgentRow } from './dashboard-agent-row'
import { useFocusedAgentPaneKey } from '@/components/sidebar/workspace-card/activity/focused-agent-row-highlight'
import { useAppStore } from '@/store/index'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import {
  readClaudeAgentViews,
  subscribeClaudeAgentViews
} from '@/runtime/provider-accounts/observations/claude-agent-view-observations'

export function useClaudeAgentRowView(agent: DashboardAgentRow) {
  const paneKey = agent.activationPaneKey ?? agent.paneKey
  const focused = useFocusedAgentPaneKey(agent.tab.worktreeId) === paneKey
  const { agentType, structuredHostOwned, providerSessionId } = useAppStore(
    useShallow((state) => {
      const parent = state.agentStatusByPaneKey[paneKey] ?? agent.entry
      return {
        agentType: parent.agentType,
        structuredHostOwned: parent.structuredHostOwned,
        providerSessionId: parent.providerSession?.id
      }
    })
  )
  const environmentId = useAppStore((state) =>
    runtimeEnvironmentIdOrLocalUnlessTwin(state, agent.tab.worktreeId)
  )
  const revision = useAppStore((state) => {
    if (!environmentId) {
      return undefined
    }
    const environment = state.runtimeEnvironments.find((item) => item.id === environmentId)
    return environment?.pairingRevision ?? environment?.createdAt
  })
  const enabled = agentType === 'claude' && !structuredHostOwned
  const key = `${environmentId ?? 'local'}:${revision ?? ''}`
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled
        ? subscribeClaudeAgentViews(key, runtimeTargetForOwnerEnvironment(environmentId), listener)
        : () => {},
    [enabled, key, environmentId]
  )
  const read = useCallback(
    () =>
      enabled
        ? readClaudeAgentViews(key).find(
            (view) => view.paneKey === paneKey && view.sessionId === providerSessionId
          )
        : undefined,
    [enabled, key, paneKey, providerSessionId]
  )
  const view = useSyncExternalStore(subscribe, read, read)
  if (!view) {
    return null
  }
  const current =
    agent.rowSource === 'subagent'
      ? view.agentId === (agent.childRow?.providerId ?? agent.childRow?.id)
      : !view.agentId
  return { current, focused }
}
