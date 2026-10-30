import type { CurrentRequestsContract } from './agent-session-current-requests-capability'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import type { MessageQuestionOccurrence } from './message-question-occurrence'
import type { AgentType } from './native-chat-types'

export type SourceContext = { sessionId: string; boundary: string }
export type CurrentRequestsPayload = {
  blocking: AgentJournalRenderItem[]
  asyncQuestions: readonly MessageQuestionOccurrence[] | null
  context: SourceContext
}

export type AgentSessionCurrentRequestsMarker = {
  contract: CurrentRequestsContract
  sessionId: string
  epoch: string
  publisher: string
  revision: number
  owner: string
  version: string
}

export type AgentSessionCurrentRequestsRead = {
  sessionId: string
  version: string
  cursor?: number
}

export type CancelCurrentQuestions = { sessionId: string; ids: string[] }
export type NativeChatCancelCurrentQuestions = CancelCurrentQuestions & {
  agent: AgentType
  transcriptPath?: string
}

export type NativeChatCurrentRequestsRead = AgentSessionCurrentRequestsRead & {
  agent: AgentType
  transcriptPath?: string
}

export type AgentSessionCurrentRequestsPiece = {
  marker: AgentSessionCurrentRequestsMarker
  json: string
  nextCursor: number | null
  restart?: true
}
