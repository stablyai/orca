import { useQueuedSteerIntents } from '../../queue/use-queued-steer-intents'
import { useMemo } from 'react'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { withNativeChatCutTurnNotices } from '../../../../../../shared/native-chat/transcript/turns/native-chat-cut-turn-notice'
import { useStructuredAgentSessionTranscriptPending } from '../../session/structured/delivery/use-structured-agent-session-transcript-pending'
import { createDesktopStructuredAgentSessionMessageProjection } from './structured-agent-session-message-projection'

export function useStructuredAgentSessionMessages(
  rows: readonly AgentJournalRenderItem[],
  agentName: string,
  chat: Omit<Parameters<typeof useStructuredAgentSessionTranscriptPending>[0], 'steerIntents'> & {
    owner: Parameters<typeof useQueuedSteerIntents>[0]
    epoch: string | null
    fence: number | null
  },
  pending: Parameters<typeof useStructuredAgentSessionTranscriptPending>[1],
  isWorking: boolean
) {
  const transcriptItems = useMemo(
    () => withNativeChatCutTurnNotices(rows, { agentName }),
    [agentName, rows]
  )
  const steer = useQueuedSteerIntents(chat.owner, chat, isWorking)
  const transcriptPending = useStructuredAgentSessionTranscriptPending(
    { ...chat, steerIntents: steer.intents },
    pending,
    isWorking
  )
  const project = useMemo(() => createDesktopStructuredAgentSessionMessageProjection(), [])
  const { submissions } = chat
  const messages = useMemo(
    () => project(transcriptItems, transcriptPending, submissions),
    [transcriptItems, transcriptPending, submissions, project]
  )
  return { transcriptItems, transcriptPending, messages, steer }
}
