import type {
  NativeChatAppendedMessages,
  NativeChatReadSessionResult
} from '../../../../preload/api-types'
import type { NativeChatTurnLifecycle } from '../../../../shared/native-chat-types'

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

export function parseRuntimeNativeChatReadSessionResult(
  value: unknown
): NativeChatReadSessionResult {
  if (typeof value !== 'object' || value === null) {
    return { error: RUNTIME_NATIVE_CHAT_READ_ERROR }
  }
  const record = value as Record<string, unknown>
  if (Array.isArray(record.messages)) {
    const lifecycle = parseRuntimeNativeChatTurnLifecycle(record.lifecycle)
    return {
      messages: record.messages as NativeChatAppendedMessages,
      ...(lifecycle ? { lifecycle } : {})
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
