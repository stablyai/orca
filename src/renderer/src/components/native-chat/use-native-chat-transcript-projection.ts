import { useMemo } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatSubagentRow } from '../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { AgentSessionLatestTurn } from '../../../../shared/agent-session/agent-session-wire'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'
import { createNativeChatConversationProjection } from './native-chat-conversation-projection'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

/** Separate conversation/subagent rows, using journal turn placement when available. */
export function useNativeChatTranscriptProjection(
  session: NativeChatLiveSession,
  journalItems: readonly AgentJournalRenderItem[] | undefined,
  journalSubmissions: readonly AgentJournalSubmission[] | undefined,
  latestTurn?: AgentSessionLatestTurn | null
): {
  messages: NativeChatMessage[]
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
} {
  const projectMessages = useMemo(
    () => createNativeChatMessageListProjection(),
    // Rebound sessions must release the previous transcript's cached rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.agent, session.sessionId]
  )
  const projection = useMemo(
    () =>
      projectMessages(
        session.messages,
        journalItems
          ? { items: journalItems, submissions: journalSubmissions ?? [], latestTurn }
          : null
      ),
    [journalItems, journalSubmissions, latestTurn, projectMessages, session.messages]
  )
  const projectConversation = useMemo(
    () => createNativeChatConversationProjection(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.agent, session.sessionId]
  )
  const hideGoals = journalItems !== undefined
  const messages = useMemo(
    () => projectConversation(projection.conversation, hideGoals),
    [hideGoals, projectConversation, projection.conversation]
  )
  return { messages, subagentRows: projection.subagentRows }
}
