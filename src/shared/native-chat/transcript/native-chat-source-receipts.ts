import type { NativeChatMessage } from '../native-chat-types'
import type { NativeChatPendingSend } from './native-chat-pending-sends'
import { nativeChatPendingMatchingAfter } from './native-chat-pending-occurrence'

export type NativeChatSourcePosition = { kind: 'order' | 'offset'; value: number }
export type NativeChatSourceReceipt = { sessionId: string; id: string }
export type NativeChatSourceBoundary = NativeChatSourceReceipt & {
  timestamp: number | null
  position?: NativeChatSourcePosition
}

export function nativeChatSourcePosition(
  message: NativeChatMessage
): NativeChatSourcePosition | undefined {
  return message.transcriptOrder !== undefined
    ? { kind: 'order', value: message.transcriptOrder }
    : message.transcriptOffset !== undefined
      ? { kind: 'offset', value: message.transcriptOffset }
      : undefined
}

export function nativeChatSourceReceiptKey(receipt: NativeChatSourceReceipt): string {
  return `${receipt.sessionId.length}:${receipt.sessionId}${receipt.id}`
}

export type NativeChatReceiptDependency = {
  receipt: NativeChatSourceReceipt
  members: string[]
  proof: 'source' | 'legacy'
}

export type NativeChatReceiptRow = { message: NativeChatMessage; index: number }
export type NativeChatReceiptSnapshot = {
  rows: NativeChatReceiptRow[]
  boundaries: Map<string, number>
}
const snapshots = new WeakMap<readonly NativeChatMessage[], NativeChatReceiptSnapshot>()

export function nativeChatReceiptSnapshot(
  messages: readonly NativeChatMessage[]
): NativeChatReceiptSnapshot {
  const cached = snapshots.get(messages)
  if (cached) {
    return cached
  }
  const boundaries = new Map<string, number>()
  const rows: NativeChatReceiptRow[] = []
  messages.forEach((message, index) => {
    if (!boundaries.has(message.id)) {
      boundaries.set(message.id, index)
      rows.push({ message, index })
    }
  })
  const result = { rows, boundaries }
  snapshots.set(messages, result)
  return result
}

/** Both the user witness and its later advancement use this same original window. */
export function nativeChatReceiptWindow(
  entry: NativeChatPendingSend,
  snapshot: NativeChatReceiptSnapshot,
  sessionId: string,
  glue = false
): (row: NativeChatReceiptRow) => boolean {
  const boundary = entry.sourceBoundary
  const sameSession = boundary?.sessionId === sessionId
  const boundaryId = boundary && !sameSession ? undefined : entry.afterMessageId
  const boundaryIndex = sameSession
    ? snapshot.boundaries.get(boundary.id)
    : boundaryId
      ? snapshot.boundaries.get(boundaryId)
      : undefined
  return ({ message, index }) => {
    const position = nativeChatSourcePosition(message)
    if (sameSession && boundary.position && position?.kind === boundary.position.kind) {
      return position.value > boundary.position.value
    }
    if (boundaryIndex !== undefined) {
      return index > boundaryIndex
    }
    if (!boundary && boundaryId === undefined && !glue) {
      return true
    }
    if (
      boundaryId === null &&
      entry.afterEmptyTranscriptSessionId &&
      (!sessionId || entry.afterEmptyTranscriptSessionId === sessionId)
    ) {
      return true
    }
    if (message.timestamp === null) {
      return true
    }
    const timestamp = nativeChatPendingMatchingAfter(entry)
    return entry.afterMessageTimestamp == null
      ? message.timestamp >= timestamp
      : message.timestamp > timestamp
  }
}
