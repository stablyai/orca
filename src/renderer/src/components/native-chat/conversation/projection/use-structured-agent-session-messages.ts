import { useMemo } from 'react'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { withNativeChatCutTurnNotices } from '../../../../../../shared/native-chat/transcript/turns/native-chat-cut-turn-notice'
import { useStructuredAgentSessionTranscriptPending } from '../../session/structured/delivery/use-structured-agent-session-transcript-pending'
import { createDesktopStructuredAgentSessionMessageProjection } from './structured-agent-session-message-projection'

export function useStructuredAgentSessionMessages(
  rows: readonly AgentJournalRenderItem[],
  agentName: string,
  chat: Parameters<typeof useStructuredAgentSessionTranscriptPending>[0],
  pending: Parameters<typeof useStructuredAgentSessionTranscriptPending>[1],
  isWorking: boolean
) {
  const transcriptItems = useMemo(
    () => withNativeChatCutTurnNotices(rows, { agentName }),
    [agentName, rows]
  )
  const transcriptPending = useStructuredAgentSessionTranscriptPending(chat, pending, isWorking)
  const project = useMemo(() => createDesktopStructuredAgentSessionMessageProjection(), [])
  const { submissions } = chat
  const messages = useMemo(
    () => project(transcriptItems, transcriptPending, submissions),
    [transcriptItems, transcriptPending, submissions, project]
  )
  return { transcriptItems, transcriptPending, messages }
}
