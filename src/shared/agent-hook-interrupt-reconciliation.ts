import type { AgentProviderSessionMetadata } from './agent-session-resume'

export const AGENT_HOOK_INFER_INTERRUPT_METHOD = 'agent_hook.inferInterrupt' as const

export type RemoteAgentInterruptRequest = {
  paneKey: string
  hostTurnRevision: string
  launchToken?: string
  providerSession: AgentProviderSessionMetadata
  intent: 'ctrl-c'
}

export type RemoteAgentInterruptDispatch = {
  connectionId: string
  request: RemoteAgentInterruptRequest
}

export function normalizeHostTurnRevision(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined
}
