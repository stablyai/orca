import { useMemo } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatSubagentRow } from '../../../../shared/native-chat-transcript-projection'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { AgentSessionLatestTurn } from '../../../../shared/agent-session-wire'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'
import { projectNativeChatTaskListFrames } from './native-chat-task-list-frames'
import { omitNativeChatThreadGoalRows } from './native-chat-thread-goal-rows'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

/** The conversation rows the list draws, and each subagent's rows apart, placed in turns by
 *  the journal when the lane has one. */
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
  const messages = useMemo(() => {
    const projected = projectNativeChatTaskListFrames(projection.conversation)
    // Structured sessions show goal state in the banner above the composer.
    return journalItems ? omitNativeChatThreadGoalRows(projected) : projected
  }, [journalItems, projection.conversation])
  return { messages, subagentRows: projection.subagentRows }
}
