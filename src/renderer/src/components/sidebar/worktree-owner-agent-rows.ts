import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AgentPresenceByPaneKey } from '@/store/slices/agent-presence'
import { selectLiveOwnerAgent } from '@/lib/agent-presence-selectors'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TitleDerivedPaneForeground } from './title-derived-pane-agent-identity'
import { buildTitleDerivedAgentRow } from './worktree-title-derived-agent-rows'

/** A pane the host recorded a live owner for is an agent row even untitled or unfocused. */
export function buildOwnerOnlyAgentRows(args: {
  agentPresenceByPaneKey?: AgentPresenceByPaneKey
  tabs: TerminalTab[]
  ptyIdsByTabId?: Record<string, string[]>
  paneForegroundAgentByPaneKey?: Record<string, TitleDerivedPaneForeground>
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  seenPaneKeys: Set<string>
  now: number
}): DashboardAgentRow[] {
  const rows: DashboardAgentRow[] = []
  const tabsById = new Map(args.tabs.map((tab) => [tab.id, tab] as const))
  for (const [paneKey, record] of Object.entries(args.agentPresenceByPaneKey ?? {})) {
    const pane = parsePaneKey(paneKey)
    const tab = pane && !args.seenPaneKeys.has(paneKey) ? tabsById.get(pane.tabId) : undefined
    if (
      !tab ||
      !pane ||
      !selectLiveOwnerAgent(record.presence) ||
      !tabHasLivePty(args.ptyIdsByTabId ?? {}, tab.id)
    ) {
      continue
    }
    const row = buildTitleDerivedAgentRow({
      tab,
      leafId: pane.leafId,
      title: '',
      ownerAgentType: null,
      paneForegroundAgentByPaneKey: args.paneForegroundAgentByPaneKey ?? {},
      agentPresenceByPaneKey: args.agentPresenceByPaneKey,
      now: args.now,
      runtimeAgentOrchestrationByPaneKey: args.runtimeAgentOrchestrationByPaneKey
    })
    if (row) {
      rows.push(row)
      args.seenPaneKeys.add(row.paneKey)
    }
  }
  return rows
}
