import type { CurrentRequestsContract } from './agent-session-current-requests-capability'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import type { AsyncQuestionContributor } from './native-chat/input/native-chat-ask'

export type SourceContext = { sessionId: string; boundary: string }
export type CurrentRequestsPayload = {
  blocking: AgentJournalRenderItem[]
  asyncQuestions: AsyncQuestionContributor[]
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

export type AgentSessionCurrentRequestsPiece = {
  marker: AgentSessionCurrentRequestsMarker
  json: string
  nextCursor: number | null
  restart?: true
}
