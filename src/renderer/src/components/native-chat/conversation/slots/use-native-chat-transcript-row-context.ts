import { useMemo } from 'react'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatTranscriptRowContext } from '../../messages/rows/NativeChatTranscriptRow'
import type { StructuredAgentSessionHostWork } from '../../session/structured/use-structured-agent-session-transport-state'

type NativeChatTranscriptRowContextInput = Omit<
  NativeChatTranscriptRowContext,
  'agentName' | 'actionablePromptIds' | 'timedRows' | 'heldTextSession' | 'savesAsRepliesGrow'
> & {
  session: Pick<NativeChatLiveSession, 'agent' | 'sessionId'>
  hostWork: StructuredAgentSessionHostWork | undefined
}

export function useNativeChatTranscriptRowContext({
  session: { agent, sessionId },
  turnBot,
  hostWork,
  expandSignal,
  revealedDiff,
  taskListPredecessors,
  expandedTurnIds,
  latestTurnKey,
  deliveryNotices,
  runtimeContext,
  structuredAttachments,
  onToggleExpandedTurn,
  onOpenSubagent,
  onScrollMessageToTop,
  readerAtEnd,
  onRevealDiff
}: NativeChatTranscriptRowContextInput): NativeChatTranscriptRowContext {
  return useMemo<NativeChatTranscriptRowContext>(
    () => ({
      turnBot,
      agentName: structuredAgentLabel(agent),
      heldTextSession: sessionId ?? undefined,
      savesAsRepliesGrow: agent === 'claude' || agent === 'codex',
      actionablePromptIds: hostWork?.actionablePromptIds,
      expandSignal,
      revealedDiff,
      taskListPredecessors,
      expandedTurnIds,
      latestTurnKey,
      deliveryNotices,
      runtimeContext,
      structuredAttachments,
      onToggleExpandedTurn,
      onOpenSubagent,
      onScrollMessageToTop,
      readerAtEnd,
      onRevealDiff
    }),
    [
      agent,
      sessionId,
      turnBot,
      hostWork,
      expandSignal,
      expandedTurnIds,
      latestTurnKey,
      deliveryNotices,
      onRevealDiff,
      revealedDiff,
      runtimeContext,
      structuredAttachments,
      onScrollMessageToTop,
      readerAtEnd,
      taskListPredecessors,
      onOpenSubagent,
      onToggleExpandedTurn
    ]
  )
}
