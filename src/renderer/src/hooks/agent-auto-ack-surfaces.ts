/**
 * The surface half of auto-acknowledgement: which adapter owns a viewed target's address, what
 * the workspace still holds across every surface kind, and the write that acknowledges one target.
 */
import type { useAppStore } from '@/store'
import type {
  AgentAttentionRemainder,
  AgentAttentionSurface
} from '@/attention/agent-attention-contract'
import {
  applyAgentAttentionAcknowledgement,
  computeAgentAcknowledgementTargets,
  mergeAgentAttentionRemainders,
  readAgentAttentionTurnStartedAt,
  resolveViewedUnreadSubjectKey,
  shouldClearWorkspaceAttention,
  type AgentAttentionTurnRecords
} from '@/attention/agent-attention-acknowledgement'
import { createTerminalAttentionSurface } from '@/components/terminal-pane/terminal-attention-surface'
import { createStructuredAttentionSurface } from '@/components/native-chat/structured-attention-surface'
import type { AutoAckTabTarget } from './agent-auto-ack-targets'

type StoreSnapshot = ReturnType<typeof useAppStore.getState>

/** The adapter that owns a target's address; terminal and structured tab ids never mix. */
export function surfaceForAutoAckTarget(
  state: StoreSnapshot,
  target: AutoAckTabTarget
): AgentAttentionSurface {
  return target.surfaceKind === 'structured'
    ? createStructuredAttentionSurface(state)
    : createTerminalAttentionSurface(state)
}

/**
 * Attention the workspace still holds, as every surface kind sees it.
 *
 * Why both: workspace unread belongs to the workspace, not to one surface kind, so asking only
 * the acknowledged kind would report a hidden sibling of the other kind as absent.
 */
function collectWorkspaceAttentionRemainder(
  state: StoreSnapshot,
  workspaceId: string
): AgentAttentionRemainder {
  return mergeAgentAttentionRemainders([
    createTerminalAttentionSurface(state).collectWorkspaceAttentionRemainder(workspaceId),
    createStructuredAttentionSurface(state).collectWorkspaceAttentionRemainder(workspaceId)
  ])
}

/** Subject-keyed view of the store's turn bookkeeping for the neutral acknowledgement policy. */
export function readAgentAttentionTurnRecords(state: StoreSnapshot): AgentAttentionTurnRecords {
  return {
    liveTurns: state.agentStatusByPaneKey,
    retainedTurns: state.retainedAgentsByPaneKey,
    acknowledgedTurnStartedAt: state.acknowledgedAgentsByPaneKey
  }
}

/** Acknowledge the one subject a viewed target shows, leaving hidden siblings' attention alone. */
export function acknowledgeViewedAutoAckTarget(
  state: StoreSnapshot,
  target: AutoAckTabTarget
): void {
  const records = readAgentAttentionTurnRecords(state)
  const groupId = target.tabId
  const subjectKey = surfaceForAutoAckTarget(state, target).resolveViewedSubjectKey(groupId)
  const toAck = computeAgentAcknowledgementTargets(records, subjectKey).filter(
    (key) =>
      state.manuallyUnreadTurnsByPaneKey[key] !== readAgentAttentionTurnStartedAt(records, key)
  )
  const viewedUnreadSubjectKey = resolveViewedUnreadSubjectKey(
    state.unreadAgentCompletionPanes,
    subjectKey
  )
  if (toAck.length === 0 && !viewedUnreadSubjectKey) {
    return
  }
  const clearedSubjectKeys = new Set(toAck)
  if (viewedUnreadSubjectKey) {
    clearedSubjectKeys.add(viewedUnreadSubjectKey)
  }
  const workspaceId = target.worktreeId
  applyAgentAttentionAcknowledgement(
    {
      acknowledgeSubjects: state.acknowledgeAgents,
      clearWorkspaceUnread: state.clearWorktreeUnread,
      clearGroupUnread: state.clearTerminalTabUnread,
      clearSubjectUnread: state.clearTerminalPaneUnread
    },
    {
      workspaceIdToClear:
        workspaceId !== null &&
        shouldClearWorkspaceAttention(collectWorkspaceAttentionRemainder(state, workspaceId), {
          viewedGroupId: groupId,
          clearedSubjectKeys
        })
          ? workspaceId
          : null,
      viewedGroupId: groupId,
      subjectKeys: toAck,
      viewedUnreadSubjectKey
    }
  )
}
