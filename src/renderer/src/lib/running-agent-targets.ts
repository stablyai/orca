import type { AppState } from '@/store/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import type { TerminalTab } from '../../../shared/types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { isExplicitAgentStatusFresh } from './agent-status'

export type RunningAgentTargetState = Pick<
  AppState,
  'agentStatusByPaneKey' | 'tabsByWorktree' | 'terminalLayoutsByTabId' | 'ptyIdsByTabId'
>

export type RunningAgentSendTarget = {
  paneKey: string
  tabId: string
  leafId: string
  tab: TerminalTab
  entry: AgentStatusEntry
  ptyId: string | null
  status: 'eligible' | 'disabled'
  disabledReason?: string
}

export function deriveRunningAgentSendTargets(
  state: RunningAgentTargetState,
  worktreeId: string,
  now = Date.now()
): RunningAgentSendTarget[] {
  const tabs = state.tabsByWorktree[worktreeId] ?? []
  if (tabs.length === 0) {
    return []
  }

  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]))
  const targets: RunningAgentSendTarget[] = []

  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    const parsed = parsePaneKey(paneKey)
    if (!parsed) {
      continue
    }
    const tab = tabsById.get(parsed.tabId)
    if (!tab) {
      continue
    }

    const layoutPtyId =
      state.terminalLayoutsByTabId[parsed.tabId]?.ptyIdsByLeafId?.[parsed.leafId] ?? null
    const ptyId =
      layoutPtyId && state.ptyIdsByTabId[parsed.tabId]?.includes(layoutPtyId) ? layoutPtyId : null
    let disabledReason: string | undefined

    if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      disabledReason = 'Agent status is stale'
    } else if (!ptyId) {
      disabledReason = 'Terminal is no longer available'
    } else if (entry.state === 'working') {
      disabledReason = 'Agent is working'
    }

    targets.push({
      paneKey,
      tabId: parsed.tabId,
      leafId: parsed.leafId,
      tab,
      entry,
      ptyId,
      status: disabledReason ? 'disabled' : 'eligible',
      ...(disabledReason ? { disabledReason } : {})
    })
  }

  return targets
}

export function resolveRunningAgentSendTarget(
  state: RunningAgentTargetState,
  worktreeId: string,
  paneKey: string,
  now = Date.now()
): RunningAgentSendTarget | null {
  return (
    deriveRunningAgentSendTargets(state, worktreeId, now).find((t) => t.paneKey === paneKey) ?? null
  )
}
