import { useMemo } from 'react'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import type { NativeChatTranscriptRowContext } from './NativeChatTranscriptRow'
import type { StructuredAgentSessionHostWork } from './use-structured-agent-session-transport-state'

type NativeChatTranscriptRowContextInput = Omit<
  NativeChatTranscriptRowContext,
  'agentName' | 'actionablePromptIds'
> & {
  agent: NativeChatLiveSession['agent']
  hostWork: StructuredAgentSessionHostWork | undefined
}

/** The context every transcript row reads, stable until one of its inputs changes. */
export function useNativeChatTranscriptRowContext({
  agent,
  hostWork,
  expandSignal,
  revealedDiff,
  taskListPredecessors,
  expandedTurnIds,
  deliveryNotices,
  allowFileUriLinks,
  runtimeContext,
  onLinkClick,
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
      deliveryNotices,
      allowFileUriLinks,
      runtimeContext,
      onLinkClick,
      onToggleExpandedTurn,
      subagentDisclosure,
      onScrollMessageToTop,
      onRevealDiff
    }),
    [
      agent,
      hostWork,
      allowFileUriLinks,
      expandSignal,
      expandedTurnIds,
      deliveryNotices,
      onLinkClick,
      onRevealDiff,
      revealedDiff,
      runtimeContext,
      onScrollMessageToTop,
      taskListPredecessors,
      subagentDisclosure,
      onToggleExpandedTurn
    ]
  )
}
