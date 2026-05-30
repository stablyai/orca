import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalTab } from '../../../shared/types'
import { parsePaneKey } from '../../../shared/stable-pane-id'

type RunningAgentTargetState = Pick<
  AppState,
  'agentStatusByPaneKey' | 'tabsByWorktree' | 'terminalLayoutsByTabId'
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
  worktreeId: string
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

    const ptyId =
      state.terminalLayoutsByTabId[parsed.tabId]?.ptyIdsByLeafId?.[parsed.leafId] ?? null
    let disabledReason: string | undefined

    if (!ptyId) {
      disabledReason = 'Terminal is no longer available'
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
  paneKey: string
): RunningAgentSendTarget | null {
  return deriveRunningAgentSendTargets(state, worktreeId).find((t) => t.paneKey === paneKey) ?? null
}
