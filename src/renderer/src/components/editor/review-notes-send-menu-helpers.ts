import { useAppStore } from '@/store'
import {
  deriveNotesSendAgentTargets,
  type NotesSendAgentTarget
} from '@/lib/notes-send-agent-targets'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { lastEnteredDoneAt } from '@/components/dashboard/agent-finished-timestamp'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

export type OrderedSendTarget = {
  target: NotesSendAgentTarget
  agent: DashboardAgentRowData | null
}

export function getTerminalIndexForTab(
  tabs: TerminalTab[] | undefined,
  tabId: string
): { terminalIndex: number | undefined; tabColor: string | null } {
  if (!tabs) {
    return { terminalIndex: undefined, tabColor: null }
  }
  const idx = tabs.findIndex((t) => t.id === tabId)
  if (idx === -1) {
    return { terminalIndex: undefined, tabColor: null }
  }
  return { terminalIndex: idx + 1, tabColor: tabs[idx].color }
}

export function resolveCurrentSendTargetEligibility(
  target: NotesSendAgentTarget,
  worktreeId: string
): { status: 'eligible' } | { status: 'disabled'; disabledReason: string } {
  const state = useAppStore.getState()
  const currentTarget = deriveNotesSendAgentTargets(state, worktreeId).find(
    (candidate) => candidate.paneKey === target.paneKey
  )
  if (currentTarget) {
    return currentTarget.status === 'eligible'
      ? { status: 'eligible' }
      : {
          status: 'disabled',
          disabledReason: currentTarget.disabledReason ?? 'Terminal is no longer available'
        }
  }

  return { status: 'disabled', disabledReason: 'Terminal is no longer available' }
}

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

export function formatAgentRelativeTime(agent: DashboardAgentRowData, now: number): string | null {
  const doneAt = lastEnteredDoneAt(agent)
  if (doneAt !== null) {
    return `${formatTimeAgo(doneAt, now)}`
  }
  const startedAt = agent.startedAt > 0 ? agent.startedAt : agent.entry.stateStartedAt
  return startedAt > 0 ? `${formatTimeAgo(startedAt, now)}` : null
}

export function formatTimeAgo(ts: number, now: number): string {
  const delta = now - ts
  if (delta < 60_000) {
    return 'just now'
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  return `${Math.floor(hours / 24)}d ago`
}
