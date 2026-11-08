import type { AgentKind } from './telemetry-events'

export const STRUCTURED_CHAT_START_TELEMETRY_CLIENT_CAPABILITY =
  'structured-chat-start-telemetry-v1'

export type StructuredChatStartTelemetryEvent = {
  type: 'structuredChatAgentStart'
  id: string
  agent_kind: AgentKind
  launch_source: 'unknown'
  request_kind: 'new' | 'resume'
}

export type StructuredChatTelemetryEvent = StructuredChatStartTelemetryEvent
