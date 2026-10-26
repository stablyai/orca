import { useCallback, useSyncExternalStore } from 'react'
import type { DashboardAgentRow } from './useDashboardData'
import { useFocusedAgentPaneKey } from '@/components/sidebar/focused-agent-row-highlight'
import { useAppStore } from '@/store'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import {
  readClaudeAgentViews,
  subscribeClaudeAgentViews
} from '@/runtime/claude-agent-view-observations'

export function useClaudeAgentRowView(agent: DashboardAgentRow) {
  const paneKey = agent.activationPaneKey ?? agent.paneKey
  const focused = useFocusedAgentPaneKey(agent.tab.worktreeId) === paneKey
  const parent = useAppStore((state) => state.agentStatusByPaneKey[paneKey]) ?? agent.entry
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
  const enabled =
    parent.agentType === 'claude' && !parent.structuredHostOwned && agent.rowSource !== 'retained'
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
            (view) => view.paneKey === paneKey && view.sessionId === parent.providerSession?.id
          )
        : undefined,
    [enabled, key, paneKey, parent.providerSession?.id]
  )
  const view = useSyncExternalStore(subscribe, read, read)
  if (!view) {
    return null
  }
  const child = agent.rowSource === 'subagent'
  const current = child
    ? view.agentId === (agent.childRow?.providerId ?? agent.childRow?.id)
    : !view.agentId
  const viewedChild = parent.children?.find((item) => (item.providerId ?? item.id) === view.agentId)
  const legacyChild = parent.subagents?.find((item) => item.id === view.agentId)
  const label =
    viewedChild?.name ||
    viewedChild?.description ||
    viewedChild?.agentType ||
    legacyChild?.description ||
    legacyChild?.agentType ||
    view.agentId
  return { current, agentId: view.agentId, child, label, focused }
}
