import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  AgentStatusEntry,
  AgentType
} from '../../../../shared/agent-status/contracts/agent-status-types'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { activateStructuredAgentSessionTab } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { activateTabAndFocusPane } from '@/lib/workspace/tabs/activate-tab-and-focus-pane'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  paneKeyTabId,
  workspaceLiveMarkerTabIds
} from '@/store/slices/workspace-attention/workspace-live-markers'
import { activateWorktreeAgentPane } from './workspace-card/activity/use-worktree-agent-activation'
import { activateRetainedAgentRow } from './workspace-card/activity/activate-retained-agent-row'
import { expandWorktreeAgentList } from './workspace-card/activity/worktree-card-agents-expansion-state'
import type { SlotAgentSignals } from './worktree-card-slot-agent-signals'
import type { SlotLineKind, SlotLineSignal, SlotSignal } from './worktree-card-slot-signal'

/** The agent (or unread workspace) behind a rolled-up slot signal, so clicking the slot can open it. */
export type SlotTarget = SlotLineSignal & {
  worktreeId: string
  executionHostId?: ExecutionHostId
  /** Null for a workspace marked unread with no agent behind it. */
  paneKey: string | null
  /** A tab holding the workspace's unread marker; opens that tab rather than the workspace. */
  tabId?: string
  /** The user marked the workspace unread; it stands on its own instead of yielding to agents. */
  markedByUser?: boolean
  retained: boolean
  agentType: AgentType | null
  entry: AgentStatusEntry | null
}

const TARGET_KINDS: ReadonlySet<SlotLineKind> = new Set(['needs', 'failed', 'unread', 'working'])

export function slotTargetsFromAgentLines(
  worktreeId: string,
  signals: SlotAgentSignals,
  executionHostId?: ExecutionHostId
): SlotTarget[] {
  const targets: SlotTarget[] = []
  for (const { agent, signal } of signals.lineByPaneKey.values()) {
    if (!TARGET_KINDS.has(signal.kind)) {
      continue
    }
    targets.push({
      ...signal,
      worktreeId,
      executionHostId,
      // Subagents have no pane of their own; they open their spawning parent.
      paneKey: agent.activationPaneKey ?? agent.paneKey,
      retained: agent.rowSource === 'retained',
      agentType: agent.agentType,
      entry: agent.entry
    })
  }
  return targets
}

export function workspaceUnreadTarget(
  worktreeId: string,
  at: number | null,
  executionHostId?: ExecutionHostId
): SlotTarget {
  return {
    kind: 'unread',
    at,
    worktreeId,
    executionHostId,
    paneKey: null,
    retained: false,
    agentType: null,
    entry: null
  }
}

/**
 * Resolves each workspace-level unread into the tabs that hold it, read at press time so the
 * jump lands where the unread is. Your own mark stays a workspace target; a flag with no tab
 * behind it (restart, a peer) stays one too.
 */
export function expandWorkspaceUnreadTargets(
  state: AppState,
  targets: readonly SlotTarget[]
): SlotTarget[] {
  return targets.flatMap((target) => {
    if (target.kind !== 'unread' || target.paneKey !== null || target.tabId !== undefined) {
      return [target]
    }
    const markedByUser = Boolean(state.workspacesMarkedUnreadByUser[target.worktreeId])
    const tabTargets = workspaceLiveMarkerTabIds(state, target.worktreeId).map(
      (tabId): SlotTarget => ({ ...target, tabId })
    )
    return tabTargets.length === 0 || markedByUser
      ? [...tabTargets, { ...target, markedByUser }]
      : tabTargets
  })
}

function workspaceKey(target: SlotTarget): string {
  return composeWorktreeHostIdentity(target.executionHostId, target.worktreeId)
}

/** Targets for the one kind a slot shows, newest first; workspace-level unread yields to the agents that explain it. */
export function slotTargetsOfKind(
  targets: readonly SlotTarget[],
  kind: SlotLineKind
): SlotTarget[] {
  const ofKind = targets.filter((target) => target.kind === kind)
  const agentTargets = ofKind.filter((target) => target.paneKey !== null)
  const withAgent = new Set(agentTargets.map(workspaceKey))
  const agentTabs = new Set(
    agentTargets.map((target) => `${workspaceKey(target)}\n${paneKeyTabId(target.paneKey!) ?? ''}`)
  )
  const seen = new Set<string>()
  return ofKind
    .filter((target) => {
      if (target.paneKey !== null || target.markedByUser) {
        return true
      }
      // A marker tab whose agent already has its own target is that agent's unread, not another one.
      return target.tabId !== undefined
        ? !agentTabs.has(`${workspaceKey(target)}\n${target.tabId}`)
        : !withAgent.has(workspaceKey(target))
    })
    .filter((target) => {
      const key = `${workspaceKey(target)}\n${target.paneKey ?? ''}\n${target.tabId ?? ''}`
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
}

/** Open the target the way its own row would, after unfolding its card's agent list. */
export function openSlotTarget(target: SlotTarget): void {
  if (target.tabId !== undefined) {
    activateUnreadTab(target.worktreeId, target.tabId, target.executionHostId)
    return
  }
  const representedTab = target.paneKey
    ? getStructuredAgentSessionTabsByPaneKey(useAppStore.getState().unifiedTabsByWorktree).get(
        target.paneKey
      )
    : undefined
  const tabId = representedTab?.id ?? (target.paneKey ? parsePaneKey(target.paneKey)?.tabId : null)
  if (!target.paneKey || !tabId) {
    activateAndRevealWorkspace(target.worktreeId, { executionHostId: target.executionHostId })
    return
  }
  expandWorktreeAgentList(target.worktreeId)
  if (target.retained) {
    activateRetainedAgentRow(target.worktreeId, tabId, target.paneKey, target.executionHostId)
  } else {
    activateWorktreeAgentPane(target.worktreeId, tabId, target.paneKey, target.executionHostId)
  }
}

/** Open the tab holding a marker the way Activity opens a thread's tab; arriving reads it. */
function activateUnreadTab(
  worktreeId: string,
  tabId: string,
  executionHostId: ExecutionHostId | undefined
): void {
  if (activateAndRevealWorkspace(worktreeId, { executionHostId }) === false) {
    return
  }
  if (activateStructuredAgentSessionTab({ worktreeId, tabId })) {
    return
  }
  const state = useAppStore.getState()
  if ((state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)) {
    state.setActiveTabType('terminal', worktreeId)
    activateTabAndFocusPane(tabId, null, {
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  }
}

/** The line kind a slot points at, or null when the slot is a time, quiet, or offline. */
export function slotTargetKind(signal: SlotSignal): SlotLineKind | null {
  switch (signal.kind) {
    case 'needs':
    case 'failed':
    case 'unread':
    case 'working':
      return signal.kind
    case 'offline':
    case 'quiet':
    case 'time':
      return null
  }
}
