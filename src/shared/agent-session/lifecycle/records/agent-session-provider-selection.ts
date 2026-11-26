import * as z from 'zod'
import type { AgentSessionRecord } from '../agent-session-record'
import type { AgentJournalCursor } from '../../journal/agent-session-journal-identity'
import {
  AGENT_CHAT_PERMISSION_MODES,
  isAgentChatPermissionMode,
  type AgentChatPermissionChoice
} from '../../../agent-launch/permissions/agent-chat-permission-mode'
import { agentChatPermissionModes } from '../../../agent-launch/permissions/agent-chat-permission-support'

export type AgentSessionProviderSelection = {
  agent: string
  options?: Record<string, string>
  botDefault?: string
  /** Older queued messages retain their authorization if the new agent requires broader access. */
  consent?: {
    from: string
    fromPermission: AgentChatPermissionChoice
    hostRunId?: string
    through: AgentJournalCursor
  }
}

export const AgentSessionSelectProviderResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('selected') }),
  z.strictObject({
    status: z.literal('consent-required'),
    from: z.string().min(1),
    fromPermission: z.enum([...AGENT_CHAT_PERMISSION_MODES, 'own'])
  })
])

export type AgentSessionSelectProviderResult = z.infer<
  typeof AgentSessionSelectProviderResultSchema
>

export type AgentSessionSelectProviderParams = {
  sessionId: string
  agent: string
  options?: Record<string, string>
  consent?: {
    from: string
    fromPermission: AgentChatPermissionChoice
    permission: 'full-access'
  }
}

export function providerSwitchPermission(permission: unknown, agent: string) {
  const current = isAgentChatPermissionMode(permission) ? permission : 'ask'
  const support = agentChatPermissionModes(agent)
  if (!support) {
    return { permission: 'full-access' as const, requiresConsent: current !== 'full-access' }
  }
  const strictestAllowed = AGENT_CHAT_PERMISSION_MODES.indexOf(current)
  return {
    permission:
      AGENT_CHAT_PERMISSION_MODES.slice(0, strictestAllowed + 1).findLast((mode) =>
        support.modes.includes(mode)
      ) ?? 'ask',
    requiresConsent: false
  }
}

export type AgentSessionProviderSetup = Pick<
  AgentSessionRecord,
  | 'provider'
  | 'accountHome'
  | 'options'
  | 'permissionMode'
  | 'launchArgs'
  | 'instructionsKey'
  | 'rewind'
>

/** A new provider owns the launch, but the selected send may still fail before reaching it. */
export type AgentSessionProviderSwitch = {
  clientMessageId: string
  hostRunId: string
  from: AgentSessionProviderSetup
  fromLinkId?: string
  through: AgentJournalCursor
  queueBoundary?: AgentJournalCursor
  retryHome?: AgentSessionProviderSelection
}

export function botProviderSelectionWithoutConsent(
  selection: AgentSessionProviderSelection
): AgentSessionProviderSelection | null {
  const { consent: _consent, ...pending } = selection
  return pending.botDefault ? pending : null
}

/** A provider command goes through as-is. Its first prose message carries the saved handoff. */
export type DeferredProviderContext = {
  marker: string
  from: string
  through: AgentJournalCursor
  clearKey: string | null
  attachedTo?: string
}
