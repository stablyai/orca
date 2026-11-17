import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/rows/dashboard-agent-row'
import type { NotesSendAgentTarget } from '@/lib/agent-session/messaging/notes-send-agent-targets'

export type OrderedSendTarget = {
  target: NotesSendAgentTarget
  agent: DashboardAgentRowData | null
}

/** Send targets in the worktree's agent-row order, then any targets without a row. */
export function orderSendTargetsByWorktreeAgentRows(
  sendTargets: NotesSendAgentTarget[],
  agentRows: DashboardAgentRowData[]
): OrderedSendTarget[] {
  const targetsByPaneKey = new Map(sendTargets.map((target) => [target.paneKey, target]))
  const usedPaneKeys = new Set<string>()
  const ordered: OrderedSendTarget[] = []

  for (const agent of agentRows) {
    const target = targetsByPaneKey.get(agent.paneKey)
    if (!target) {
      continue
    }
    ordered.push({ target: { ...target, agentType: agent.agentType }, agent })
    usedPaneKeys.add(target.paneKey)
  }

  for (const target of sendTargets) {
    if (!usedPaneKeys.has(target.paneKey)) {
      ordered.push({ target, agent: null })
    }
  }

  return ordered
}
