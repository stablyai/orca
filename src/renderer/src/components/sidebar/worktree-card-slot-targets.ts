import type {
  AgentStatusEntry,
  AgentType
} from '../../../../shared/agent-status/contracts/agent-status-types'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { activateWorktreeAgentPane } from './workspace-card/activity/use-worktree-agent-activation'
import { activateRetainedAgentRow } from './workspace-card/activity/activate-retained-agent-row'
import { expandWorktreeAgentList } from './workspace-card/activity/worktree-card-agents-expansion-state'
import type { SlotAgentSignals } from './worktree-card-slot-agent-signals'
import type { SlotLineKind, SlotLineSignal, SlotSignal } from './worktree-card-slot-signal'

/** The agent (or unread workspace) behind a rolled-up slot signal, so clicking the slot can open it. */
export type SlotTarget = SlotLineSignal & {
  worktreeId: string
  /** Null for a workspace marked unread with no agent behind it. */
  paneKey: string | null
  retained: boolean
  agentType: AgentType | null
  entry: AgentStatusEntry | null
}

const TARGET_KINDS: ReadonlySet<SlotLineKind> = new Set(['needs', 'failed', 'unread', 'working'])

export function slotTargetsFromAgentLines(
  worktreeId: string,
  signals: SlotAgentSignals
): SlotTarget[] {
  const targets: SlotTarget[] = []
  for (const { agent, signal } of signals.lineByPaneKey.values()) {
    if (!TARGET_KINDS.has(signal.kind)) {
      continue
    }
    targets.push({
      ...signal,
      worktreeId,
      // Subagents have no pane of their own; they open their spawning parent.
      paneKey: agent.activationPaneKey ?? agent.paneKey,
      retained: agent.rowSource === 'retained',
      agentType: agent.agentType,
      entry: agent.entry
    })
  }
  return targets
}

export function workspaceUnreadTarget(worktreeId: string, at: number | null): SlotTarget {
  return {
    kind: 'unread',
    at,
    worktreeId,
    paneKey: null,
    retained: false,
    agentType: null,
    entry: null
  }
}

/** Targets for the one kind a slot shows, newest first; a workspace mark yields to its own agents. */
export function slotTargetsOfKind(
  targets: readonly SlotTarget[],
  kind: SlotLineKind
): SlotTarget[] {
  const ofKind = targets.filter((target) => target.kind === kind)
  const withAgent = new Set(
    ofKind.filter((target) => target.paneKey !== null).map((target) => target.worktreeId)
  )
  const seen = new Set<string>()
  return ofKind
    .filter((target) => target.paneKey !== null || !withAgent.has(target.worktreeId))
    .filter((target) => {
      const key = `${target.worktreeId}\n${target.paneKey ?? ''}`
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
  const parsed = target.paneKey ? parsePaneKey(target.paneKey) : null
  if (!target.paneKey || !parsed) {
    activateAndRevealWorkspace(target.worktreeId)
    return
  }
  expandWorktreeAgentList(target.worktreeId)
  if (target.retained) {
    activateRetainedAgentRow(target.worktreeId, parsed.tabId, target.paneKey)
  } else {
    activateWorktreeAgentPane(target.worktreeId, parsed.tabId, target.paneKey)
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
    default:
      return null
  }
}
