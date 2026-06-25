import type { AppState } from '@/store/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import type { TerminalTab } from '../../../shared/types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  detectAgentStatusFromTitle,
  getAgentLabel,
  isExplicitAgentStatusFresh
} from './agent-status'
import { resolveRuntimePaneTitleForLeaf } from './runtime-pane-title-leaf-id'

export type RunningAgentTargetState = Pick<
  AppState,
  'agentStatusByPaneKey' | 'tabsByWorktree' | 'terminalLayoutsByTabId' | 'ptyIdsByTabId'
> &
  Partial<Pick<AppState, 'runtimePaneTitlesByTabId'>>

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
      state.terminalLayoutsByTabId?.[parsed.tabId]?.ptyIdsByLeafId?.[parsed.leafId] ?? null
    const tabPtyIds = state.ptyIdsByTabId?.[parsed.tabId]
    const ptyId =
      layoutPtyId && (tabPtyIds === undefined || tabPtyIds.includes(layoutPtyId))
        ? layoutPtyId
        : null
    let disabledReason: string | undefined

    if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      disabledReason = 'Agent status is stale'
    } else if (!ptyId) {
      disabledReason = 'Terminal is no longer available'
    } else if (entry.state === 'blocked' || entry.state === 'waiting') {
      disabledReason = 'Agent needs permission'
    } else if (hasPermissionPaneTitle(state, parsed.tabId, parsed.leafId, tab.title)) {
      disabledReason = 'Agent needs permission'
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

function hasPermissionPaneTitle(
  state: RunningAgentTargetState,
  tabId: string,
  leafId: string,
  tabTitle: string
): boolean {
  const layout = state.terminalLayoutsByTabId[tabId]
  const paneTitle = resolveRuntimePaneTitleForLeaf(
    layout,
    state.runtimePaneTitlesByTabId?.[tabId],
    leafId
  )
  // Why: runtime pane titles are the freshest title signal for split panes; use
  // the tab title only before the runtime has reported a pane title for the leaf.
  const title = paneTitle ?? tabTitle
  return detectAgentStatusFromTitle(title) === 'permission' && getAgentLabel(title) !== null
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
