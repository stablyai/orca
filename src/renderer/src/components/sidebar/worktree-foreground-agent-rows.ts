import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/types'

const EMPTY_FOREGROUND_AGENTS: Record<string, PaneForegroundAgentEntry> = {}

export function buildForegroundAgentRows(
  args: {
    tabs: TerminalTab[]
    foregroundAgentsByPaneKey?: Record<string, PaneForegroundAgentEntry>
    ptyIdsByTabId?: Record<string, string[]>
    runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
    now: number
  },
  seenPaneKeys: Set<string>
): DashboardAgentRow[] {
  const rows: DashboardAgentRow[] = []
  const tabsById = new Map(args.tabs.map((tab) => [tab.id, tab]))

  for (const [paneKey, foreground] of Object.entries(
    args.foregroundAgentsByPaneKey ?? EMPTY_FOREGROUND_AGENTS
  )) {
    if (!foreground.agent || foreground.shellForeground || seenPaneKeys.has(paneKey)) {
      continue
    }
    const parsed = parsePaneKey(paneKey)
    const tab = parsed ? tabsById.get(parsed.tabId) : undefined
    if (!tab || !tabHasLivePty(args.ptyIdsByTabId ?? {}, tab.id)) {
      continue
    }

    const label = formatAgentTypeLabel(foreground.agent)
    const orchestration = args.runtimeAgentOrchestrationByPaneKey?.[paneKey]
    const entry: AgentStatusEntry = {
      paneKey,
      // AgentStatusEntry has no idle state; the row state below is authoritative.
      state: 'working',
      prompt: label,
      updatedAt: args.now,
      stateStartedAt: 0,
      stateHistory: [],
      agentType: foreground.agent,
      lastAssistantMessage: 'Session active',
      ...(orchestration ? { orchestration } : {})
    }
    // Process identity proves a live session, not turn activity.
    rows.push({
      paneKey,
      entry,
      tab,
      agentType: foreground.agent,
      rowSource: 'live',
      state: 'idle',
      startedAt: 0
    })
    seenPaneKeys.add(paneKey)
  }

  return rows
}
