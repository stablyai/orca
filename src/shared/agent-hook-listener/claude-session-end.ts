import type { AgentHookSource } from '../agent-hook-relay'
import { normalizeAgentStatusPayload } from '../agent-status-types'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'
import type { ParsedHookEnvelope } from './hook-envelope'
import { readString } from './tool-input-preview'
import { retireClaudeSessionPermissions } from './claude-permission-table'

const CLAUDE_EXIT_SESSION_END_REASONS = new Set([
  'prompt_input_exit',
  'logout',
  'other',
  'bypass_permissions_disabled'
])

export function normalizeClaudeSessionEnd(
  state: HookListenerState,
  source: AgentHookSource,
  envelope: ParsedHookEnvelope,
  providerSession: AgentHookEventPayload['providerSession'] | null,
  agentPresence: AgentHookEventPayload['agentPresence'],
  previous: AgentHookEventPayload | undefined
): AgentHookEventPayload | null {
  const reason = readString(envelope.hookPayloadRecord, 'reason')
  if (
    source !== 'claude' ||
    envelope.eventName !== 'SessionEnd' ||
    !agentPresence ||
    readString(envelope.hookPayloadRecord, 'agent_id') ||
    !reason ||
    !CLAUDE_EXIT_SESSION_END_REASONS.has(reason)
  ) {
    return null
  }
  retireClaudeSessionPermissions(state, envelope.paneKey)
  const payload =
    previous?.payload ??
    normalizeAgentStatusPayload({ state: 'done', prompt: '', agentType: source })
  if (!payload) {
    return null
  }
  return {
    paneKey: envelope.paneKey,
    source,
    launchToken: envelope.launchToken,
    tabId: envelope.tabId,
    worktreeId: envelope.worktreeId,
    connectionId: null,
    providerSession: providerSession ?? undefined,
    hookEventName: 'SessionEnd',
    agentPresence: { ...agentPresence, ended: true },
    payload
  }
}
