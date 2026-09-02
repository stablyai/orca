import type { AgentDotState } from '@/components/AgentStateDot'
import type { CanvasTerminalItem } from '@/components/tab-group/CanvasTerminalCard'
import type {
  DashboardCard,
  DashboardCardDisplayState,
  DashboardWorkspace
} from '../../../../shared/dashboard-snapshot'
import { dashboardCardDisplayState } from '../../../../shared/dashboard-snapshot'
import type { Tab } from '../../../../shared/tab-types'
import { resolveCanvasTerminalLabel } from '../../../../shared/tab-title-resolution'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { ControlRoomScope } from './control-room-preferences'

type ControlRoomItemInput = {
  cards: readonly DashboardCard[]
  workspaces?: readonly DashboardWorkspace[]
  unifiedTabsByWorktree: Readonly<Record<string, readonly Tab[] | undefined>>
  terminalTabsByWorktree: Readonly<Record<string, readonly TerminalTab[] | undefined>>
  ptyIdsByTabId: Readonly<Record<string, readonly string[] | undefined>>
  generatedTabTitlesEnabled: boolean
  pinnedSessionKeys: ReadonlySet<string>
  scope: ControlRoomScope
}

const STATE_PRIORITY: Record<DashboardCardDisplayState, number> = {
  blocked: 6,
  waiting: 5,
  working: 4,
  monitoring: 3,
  done: 2,
  idle: 1
}

type ControlRoomSessionIdentity = {
  executionHostId?: string
  worktreeId: string
  tabId: string
}

export function controlRoomSessionKey(identity: ControlRoomSessionIdentity): string {
  return `${identity.executionHostId ?? 'local'}:${identity.worktreeId}:${identity.tabId}`
}

function ownerLabel(card: Pick<DashboardCard, 'repoName' | 'worktreeName'>): string {
  return card.repoName === card.worktreeName
    ? card.repoName
    : `${card.repoName} / ${card.worktreeName}`
}

function strongestState(cards: readonly DashboardCard[]): DashboardCardDisplayState {
  let state: DashboardCardDisplayState = 'idle'
  for (const card of cards) {
    const candidate = dashboardCardDisplayState(card)
    if (STATE_PRIORITY[candidate] > STATE_PRIORITY[state]) {
      state = candidate
    }
  }
  return state
}

function includeForScope(
  scope: ControlRoomScope,
  live: boolean,
  hasAgent: boolean,
  pinned: boolean
): boolean {
  if (scope === 'pinned') {
    // A pin is a durable user choice. Keep its restored terminal card visible
    // while the PTY is offline so an app restart does not look like it forgot
    // every pinned agent.
    return pinned
  }
  if (!live) {
    return false
  }
  if (scope === 'all') {
    return true
  }
  return hasAgent
}

/**
 * Maps Orca's cross-project agent snapshot back to the existing terminal tabs.
 * One Canvas card represents one terminal tab; split agents inside it remain
 * inside that terminal, while provider subagents stay folded into the count.
 */
export function buildControlRoomTerminalItems({
  cards,
  workspaces,
  unifiedTabsByWorktree,
  terminalTabsByWorktree,
  ptyIdsByTabId,
  generatedTabTitlesEnabled,
  pinnedSessionKeys,
  scope
}: ControlRoomItemInput): CanvasTerminalItem[] {
  const cardsByRoute = new Map<string, DashboardCard[]>()
  for (const card of cards) {
    if (card.parentPaneKey) {
      continue
    }
    const key = `${card.worktreeId}:${card.tabId}`
    const existing = cardsByRoute.get(key)
    if (existing) {
      existing.push(card)
    } else {
      cardsByRoute.set(key, [card])
    }
  }

  const workspaceByWorktree = new Map(
    (workspaces ?? []).map((workspace) => [workspace.worktreeId, workspace])
  )

  const items: CanvasTerminalItem[] = []
  for (const [worktreeId, unifiedTabs] of Object.entries(unifiedTabsByWorktree)) {
    const terminals = new Map(
      (terminalTabsByWorktree[worktreeId] ?? []).map((terminal) => [terminal.id, terminal])
    )
    const workspace = workspaceByWorktree.get(worktreeId)

    for (const unifiedTab of unifiedTabs ?? []) {
      if (unifiedTab.contentType !== 'terminal') {
        continue
      }
      const terminal = terminals.get(unifiedTab.entityId)
      if (!terminal) {
        continue
      }
      const sessionCards = cardsByRoute.get(`${worktreeId}:${terminal.id}`) ?? []
      const card = sessionCards[0]
      const executionHostId =
        card?.executionHostId ?? unifiedTab.executionHostId ?? workspace?.executionHostId
      const sessionKey = controlRoomSessionKey({
        executionHostId,
        worktreeId,
        tabId: terminal.id
      })
      const pinned = pinnedSessionKeys.has(sessionKey)
      const live = terminal.ptyId !== null || (ptyIdsByTabId[terminal.id]?.length ?? 0) > 0
      if (!includeForScope(scope, live, sessionCards.length > 0, pinned)) {
        continue
      }
      const state = sessionCards.length > 0 ? strongestState(sessionCards) : undefined
      const fallbackOwner = workspace ? ownerLabel(workspace) : card ? ownerLabel(card) : worktreeId
      items.push({
        terminalTabId: terminal.id,
        unifiedTabId: unifiedTab.id,
        groupId: unifiedTab.groupId,
        worktreeId,
        executionHostId,
        sessionKey,
        label: resolveCanvasTerminalLabel(unifiedTab, terminal, generatedTabTitlesEnabled),
        color: unifiedTab.color ?? terminal.color,
        ownerLabel: fallbackOwner,
        ...(state ? { agentState: state as AgentDotState } : {}),
        ...(sessionCards.length > 0
          ? {
              agentCount: sessionCards.length,
              subagentCount: sessionCards.reduce(
                (count, entry) => count + (entry.subagents?.length ?? 0),
                0
              )
            }
          : {}),
        pinned
      })
    }
  }

  return items.sort((left, right) => {
    const leftPriority = left.agentState
      ? STATE_PRIORITY[left.agentState as DashboardCardDisplayState]
      : 0
    const rightPriority = right.agentState
      ? STATE_PRIORITY[right.agentState as DashboardCardDisplayState]
      : 0
    const stateDelta = rightPriority - leftPriority
    return (
      stateDelta ||
      (left.ownerLabel ?? '').localeCompare(right.ownerLabel ?? '') ||
      left.label.localeCompare(right.label)
    )
  })
}
