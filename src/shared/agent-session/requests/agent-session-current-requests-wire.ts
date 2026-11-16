import type { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from './agent-session-current-requests-capability'

export type AgentSessionCurrentRequestsMarker = {
  contract: typeof AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY
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
