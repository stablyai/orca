import { useMemo } from 'react'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatTranscriptRowContext } from '../../messages/rows/NativeChatTranscriptRow'
import type { StructuredAgentSessionHostWork } from '../../session/structured/use-structured-agent-session-transport-state'

type NativeChatTranscriptRowContextInput = Omit<
  NativeChatTranscriptRowContext,
  'agentName' | 'actionablePromptIds'
> & {
  agent: NativeChatLiveSession['agent']
  hostWork: StructuredAgentSessionHostWork | undefined
}

export function useNativeChatTranscriptRowContext({
  agent,
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
  subagentDisclosure,
  onScrollMessageToTop,
  onRevealDiff
}: NativeChatTranscriptRowContextInput): NativeChatTranscriptRowContext {
  return useMemo<NativeChatTranscriptRowContext>(
    () => ({
      agentName: structuredAgentLabel(agent),
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
      subagentDisclosure,
      onScrollMessageToTop,
      onRevealDiff
    }),
    [
      agent,
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
      taskListPredecessors,
      subagentDisclosure,
      onToggleExpandedTurn
    ]
  )
}
