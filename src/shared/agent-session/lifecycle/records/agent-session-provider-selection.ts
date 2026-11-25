import type { AgentSessionRecord } from '../agent-session-record'
import type { AgentJournalCursor } from '../../journal/agent-session-journal-identity'
import {
  AGENT_CHAT_PERMISSION_MODES,
  isAgentChatPermissionMode,
  type AgentChatPermissionMode
} from '../../../agent-launch/permissions/agent-chat-permission-mode'
import { agentChatPermissionModes } from '../../../agent-launch/permissions/agent-chat-permission-support'

export type AgentSessionProviderSelection = {
  agent: string
  options?: Record<string, string>
  /** Older queued messages retain their authorization if the new agent requires broader access. */
  consent?: {
    from: string
    fromPermission: AgentChatPermissionMode
    through: AgentJournalCursor
    hostRunId: string
  }
}

export type AgentSessionSelectProviderResult =
  | { status: 'selected' }
  | { status: 'consent-required'; from: string; fromPermission: AgentChatPermissionMode }

export type AgentSessionSelectProviderParams = {
  sessionId: string
  agent: string
  options?: Record<string, string>
  consent?: {
    from: string
    fromPermission: AgentChatPermissionMode
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
  from: AgentSessionProviderSetup
  fromLinkId?: string
  through: AgentJournalCursor
}
