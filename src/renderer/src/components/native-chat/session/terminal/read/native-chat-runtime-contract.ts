import type { TranscriptByteRange } from '../../../../../../../shared/native-chat/transcript/transcript-byte-range'
import type { NativeChatReadSessionResult } from '../../../../../../../preload/api/native-chat/native-chat-api'
import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../../../../../../shared/native-chat/native-chat-types'
import { translate } from '@/i18n/i18n'

export function runtimeNativeChatReadError(): string {
  return translate(
    'components.native-chat.runtime.readError',
    "Couldn't read agent chat from the remote runtime."
  )
}

export function parseRuntimeNativeChatTurnLifecycle(
  value: unknown
): NativeChatTurnLifecycle | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const record = value
  if (
    !('state' in record) ||
    !('turnId' in record) ||
    (record.state !== 'working' &&
      record.state !== 'completed' &&
      record.state !== 'interrupted') ||
    typeof record.turnId !== 'string' ||
    record.turnId.trim().length === 0 ||
    ('timestamp' in record &&
      record.timestamp !== null &&
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
    // Missing timestamps are valid; normalize them without dropping the lifecycle record.
    timestamp:
      'timestamp' in record && typeof record.timestamp === 'number' ? record.timestamp : null
  }
}

export function parseRuntimeNativeChatReadSessionResult(
  value: unknown
): NativeChatReadSessionResult {
  if (typeof value !== 'object' || value === null) {
    return { error: runtimeNativeChatReadError() }
  }
  const record = value
  if ('messages' in record && Array.isArray(record.messages)) {
    const lifecycle = parseRuntimeNativeChatTurnLifecycle(
      'lifecycle' in record ? record.lifecycle : undefined
    )
    return {
      messages: record.messages,
      ranges: parseTranscriptByteRanges('ranges' in record ? record.ranges : undefined),
      ...('hasMore' in record && typeof record.hasMore === 'boolean'
        ? { hasMore: record.hasMore }
        : {}),
      ...('beforeOffset' in record && typeof record.beforeOffset === 'number'
        ? { beforeOffset: record.beforeOffset }
        : {}),
      ...(lifecycle ? { lifecycle } : {})
    }
  }
  if ('error' in record && typeof record.error === 'string') {
    return {
      error: record.error,
      ...('notFound' in record && record.notFound === true ? { notFound: true } : {})
    }
  }
  return { error: runtimeNativeChatReadError() }
}

export function parseTranscriptByteRanges(value: unknown): TranscriptByteRange[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const ranges: TranscriptByteRange[] = []
  for (const range of value) {
    if (
      typeof range !== 'object' ||
      range === null ||
      !('start' in range) ||
      typeof range.start !== 'number' ||
      !Number.isSafeInteger(range.start) ||
      range.start < 0 ||
      !('end' in range) ||
      typeof range.end !== 'number' ||
      !Number.isSafeInteger(range.end) ||
      range.end <= range.start ||
      !('digest' in range) ||
      typeof range.digest !== 'string' ||
      !/^[0-9a-f]{16}$/.test(range.digest)
    ) {
      return undefined
    }
    ranges.push({ start: range.start, end: range.end, digest: range.digest })
  }
  return ranges
}

export function parseRuntimeNativeChatFrame(value: unknown): {
  type?: unknown
  messages?: NativeChatMessage[]
  hasMore?: boolean
  error?: string
  lifecycle?: unknown
  ranges?: unknown
  pending?: boolean
} {
  if (typeof value !== 'object' || value === null) {
    return {}
  }
  const result = parseRuntimeNativeChatReadSessionResult(value)
  return {
    ...('messages' in result ? result : {}),
    ...('type' in value ? { type: value.type } : {}),
    ...('error' in value && typeof value.error === 'string' ? { error: value.error } : {}),
    ...('pending' in value && value.pending === true ? { pending: true } : {})
  }
}
