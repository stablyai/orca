import type { AgentProcessIdentity } from '../agent-status/process/agent-process-presence'
import type { ParsedAgentStatusPayload } from '../agent-status/contracts/agent-status-types'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'
import { DROID_HOOK_SESSION_PROVIDER } from './providers/droid/droid-hook-session'

export type ProviderHookSessionInput = {
  state: HookListenerState
  paneKey: string
  eventName: unknown
  hookPayload: Record<string, unknown>
  promptText: string
  sender?: AgentProcessIdentity
  previous: AgentHookEventPayload | undefined
  base: Pick<
    AgentHookEventPayload,
    'launchToken' | 'tabId' | 'worktreeId' | 'agentPresence' | 'providerSession'
  >
}

export type HookSessionNormalization = {
  normalize(): ParsedAgentStatusPayload | null
  providerSession: AgentHookEventPayload['providerSession'] | null
  suppressPrompt?: boolean
}

export type ProviderHookSessionResult =
  | { kind: 'handled'; event: AgentHookEventPayload | null }
  | { kind: 'normalize'; normalization: HookSessionNormalization }

export type ProviderHookSession = {
  retainPaneRoot?: true
  admit(input: ProviderHookSessionInput): ProviderHookSessionResult
  readPaneSession?(
    input: Pick<ProviderHookSessionInput, 'state' | 'paneKey' | 'hookPayload'> & {
      session: NonNullable<AgentHookEventPayload['providerSession']>
    }
  ): AgentHookEventPayload['providerSession'] | null
}

const PROVIDERS: Readonly<Record<string, ProviderHookSession>> = {
  droid: DROID_HOOK_SESSION_PROVIDER
}

export function providerHookRetainsPaneRoot(source: string): boolean {
  return PROVIDERS[source]?.retainPaneRoot === true
}

export function prepareProviderHookSession(source: string, input: ProviderHookSessionInput) {
  return PROVIDERS[source]?.admit(input)
}

export function readProviderHookPaneSession(
  source: string,
  input: Parameters<NonNullable<ProviderHookSession['readPaneSession']>>[0]
) {
  const read = PROVIDERS[source]?.readPaneSession
  return read ? read(input) : input.session
}
