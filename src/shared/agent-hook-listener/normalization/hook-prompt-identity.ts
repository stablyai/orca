import { normalizeClaudePromptId, normalizeGrokPromptId } from '../listener-limits'
import type { AgentHookSource } from '../transport/agent-hook-relay'
import type { AgentHookEventPayload } from '../listener-event'

export function readHookPromptIdentity(
  source: AgentHookSource,
  eventName: unknown,
  hookPayloadRecord: Record<string, unknown>
): Pick<AgentHookEventPayload, 'providerPromptId' | 'compactTrigger'> {
  const providerPromptId =
    source === 'claude'
      ? normalizeClaudePromptId(hookPayloadRecord.prompt_id)
      : source === 'grok'
        ? normalizeGrokPromptId(hookPayloadRecord.promptId ?? hookPayloadRecord.prompt_id)
        : undefined
  const compactTrigger =
    source === 'claude' &&
    (eventName === 'PreCompact' || eventName === 'PostCompact') &&
    (hookPayloadRecord.trigger === 'manual' || hookPayloadRecord.trigger === 'auto')
      ? hookPayloadRecord.trigger
      : undefined
  return { providerPromptId, compactTrigger }
}
