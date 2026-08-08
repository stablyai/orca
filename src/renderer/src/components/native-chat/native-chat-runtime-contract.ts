import type {
  NativeChatAppendedMessages,
  NativeChatReadSessionResult
} from '../../../../preload/api-types'
import type { NativeChatTurnLifecycle } from '../../../../shared/native-chat-types'
import type { AgentSessionContextSnapshot } from '../../../../shared/agent-session-context'

export const RUNTIME_NATIVE_CHAT_READ_ERROR = "Couldn't read agent chat from the remote runtime."

export function parseRuntimeNativeChatTurnLifecycle(
  value: unknown
): NativeChatTurnLifecycle | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (
    (record.state !== 'working' &&
      record.state !== 'completed' &&
      record.state !== 'interrupted') ||
    typeof record.turnId !== 'string' ||
    record.turnId.trim().length === 0 ||
    (record.timestamp !== null &&
      record.timestamp !== undefined &&
      (typeof record.timestamp !== 'number' ||
        !Number.isFinite(record.timestamp) ||
        record.timestamp <= 0))
  ) {
    return undefined
  }
  return {
    state: record.state,
    turnId: record.turnId.trim(),
    // Why: an omitted timestamp is a valid payload; normalize it to null rather
    // than dropping the whole lifecycle record.
    timestamp: record.timestamp ?? null
  }
}

export function parseRuntimeAgentSessionContext(
  value: unknown
): AgentSessionContextSnapshot | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const nullableNumber = (field: string): number | null | undefined => {
    const candidate = record[field]
    return candidate === null
      ? null
      : typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
        ? candidate
        : undefined
  }
  const usedTokens = nullableNumber('usedTokens')
  const maxTokens = nullableNumber('maxTokens')
  const remainingTokens = nullableNumber('remainingTokens')
  const usedPercent = nullableNumber('usedPercent')
  const observedAt = nullableNumber('observedAt')
  const compactionUpdatedAt = nullableNumber('compactionUpdatedAt')
  if (
    usedTokens === undefined ||
    maxTokens === undefined ||
    remainingTokens === undefined ||
    usedPercent === undefined ||
    observedAt === undefined ||
    compactionUpdatedAt === undefined ||
    (record.source !== 'provider' &&
      record.source !== 'hook' &&
      record.source !== 'statusline' &&
      record.source !== 'unavailable') ||
    (record.compaction !== 'idle' &&
      record.compaction !== 'requested' &&
      record.compaction !== 'running' &&
      record.compaction !== 'completed' &&
      record.compaction !== 'failed')
  ) {
    return undefined
  }
  return {
    ...(typeof record.model === 'string' || record.model === null ? { model: record.model } : {}),
    ...(typeof record.effort === 'string' || record.effort === null
      ? { effort: record.effort }
      : {}),
    usedTokens,
    maxTokens,
    remainingTokens,
    usedPercent,
    source: record.source,
    observedAt,
    compaction: record.compaction,
    compactionUpdatedAt,
    ...(record.estimated === true ? { estimated: true } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {})
  }
}

export function parseRuntimeNativeChatReadSessionResult(
  value: unknown
): NativeChatReadSessionResult {
  if (typeof value !== 'object' || value === null) {
    return { error: RUNTIME_NATIVE_CHAT_READ_ERROR }
  }
  const record = value as Record<string, unknown>
  if (Array.isArray(record.messages)) {
    const lifecycle = parseRuntimeNativeChatTurnLifecycle(record.lifecycle)
    const context = parseRuntimeAgentSessionContext(record.context)
    return {
      messages: record.messages as NativeChatAppendedMessages,
      ...(lifecycle ? { lifecycle } : {}),
      ...(context ? { context } : {})
    }
  }
  if (typeof record.error === 'string') {
    return {
      error: record.error,
      ...(record.notFound === true ? { notFound: true } : {})
    }
  }
  return { error: RUNTIME_NATIVE_CHAT_READ_ERROR }
}
