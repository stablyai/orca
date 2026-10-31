import type { useAppStore } from '@/store'
import type { AgentAttentionSurface } from '@/attention/agent-attention-contract'
import {
  computeAgentAcknowledgementTargets,
  readAgentAttentionTurnStartedAt,
  resolveViewedUnreadSubjectKey,
  type AgentAttentionTurnRecords
} from '@/attention/agent-attention-acknowledgement'
import { createTerminalAttentionSurface } from '@/components/terminal-pane/terminal-attention-surface'
import { createStructuredAttentionSurface } from '@/components/native-chat/structured-attention-surface'
import type { AutoAckTabTarget } from './agent-auto-ack-targets'
import {
  emitAgentSubjectReads,
  type AgentSubjectRead
} from '@/attention/agent-subject-read-actions'

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
  target: AutoAckTabTarget,
  options?: { reads?: readonly AgentSubjectRead[]; readViewed?: boolean }
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
  const readViewed =
    options?.readViewed &&
    subjectKey !== null &&
    (state.manuallyUnreadTurnsByPaneKey[subjectKey] === undefined ||
      state.manuallyUnreadTurnsByPaneKey[subjectKey] !==
        readAgentAttentionTurnStartedAt(records, subjectKey))
  if (toAck.length === 0 && !viewedUnreadSubjectKey && !readViewed) {
    return
  }
  const clearedSubjectKeys = new Set(toAck)
  if (viewedUnreadSubjectKey) {
    clearedSubjectKeys.add(viewedUnreadSubjectKey)
  }
  if (readViewed && subjectKey) {
    clearedSubjectKeys.add(subjectKey)
  }
  emitAgentSubjectReads([...clearedSubjectKeys], options?.reads)
  // Why ack only: the tab's unread markers are read by `readOnScreenAttention` in the same scan.
  if (toAck.length > 0) {
    state.acknowledgeAgents(toAck, [])
  }
}
