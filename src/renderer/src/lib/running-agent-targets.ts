import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalTab } from '../../../shared/types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { resolvePaneAgentActivity } from '@/lib/pane-agent-evidence'
import { detectAgentSendTitleStatus } from './agent-send-title-status'
import { resolveRuntimePaneTitleLeafResolution } from './runtime-pane-title-leaf-id'

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

    // Why: the shared resolver gates hook freshness; a null hookState means the
    // entry is stale (entries here always exist), and otherwise carries the
    // fresh entry.state. The live-title layer stays local because it needs the
    // send-gated detector (label + strict idle-send gate), which the resolver's
    // raw titleStatus does not reproduce.
    const decision = resolvePaneAgentActivity({
      explicitEntry: entry,
      liveTitle: null,
      hasLivePty: ptyId !== null,
      now
    })
    // Why: hook-backed rows can go stale while the same PTY is still a live
    // agent; live titles are the runtime proof that the row remains targetable.
    const liveTitleStatus = ptyId
      ? detectLiveAgentPaneStatus(state, parsed.tabId, parsed.leafId, tab.title)
      : null
    if (decision.hookState === null) {
      if (liveTitleStatus === 'permission') {
        disabledReason = 'Agent needs permission'
      } else if (liveTitleStatus === null) {
        disabledReason = 'Agent status is stale'
      }
    } else if (!ptyId) {
      disabledReason = 'Terminal is no longer available'
    } else if (decision.hookState === 'blocked' || decision.hookState === 'waiting') {
      disabledReason = 'Agent needs permission'
    } else if (liveTitleStatus === 'permission') {
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

function detectLiveAgentPaneStatus(
  state: RunningAgentTargetState,
  tabId: string,
  leafId: string,
  tabTitle: string
): ReturnType<typeof detectAgentSendTitleStatus> {
  const layout = state.terminalLayoutsByTabId[tabId]
  const paneTitles = state.runtimePaneTitlesByTabId?.[tabId]
  const paneTitleResolution = resolveRuntimePaneTitleLeafResolution(layout, paneTitles, leafId)
  // Why: runtime pane titles are the freshest title signal for split panes; use
  // the tab title only before the runtime has reported a pane title for the leaf.
  const title = paneTitleResolution.title ?? (paneTitleResolution.hasAnyPaneTitle ? null : tabTitle)
  if (title === null) {
    return null
  }
  return detectAgentSendTitleStatus(title)
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
