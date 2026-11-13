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
  const original = receiptWindowAfter(
    boundary && !sameSession ? { ...entry, afterMessageId: null } : entry,
    snapshot,
    sessionId,
    glue
  )
  if (!sameSession) {
    return original
  }
  const frontier = receiptWindowAfter(
    {
      ...entry,
      afterMessageId: boundary.id,
      afterMessageTimestamp: boundary.timestamp,
      matchingAfterTimestamp: undefined,
      afterEmptyTranscriptSessionId: undefined
    },
    snapshot,
    sessionId,
    glue
  )
  return (row) => {
    const position = nativeChatSourcePosition(row.message)
    if (boundary.position && position?.kind === boundary.position.kind) {
      return (
        position.value > boundary.position.value &&
        (boundary.id === entry.afterMessageId || original(row))
      )
    }
    if (!original(row)) {
      return false
    }
    return frontier(row)
  }
}

function receiptWindowAfter(
  entry: NativeChatPendingSend,
  snapshot: NativeChatReceiptSnapshot,
  sessionId: string,
  glue: boolean
): (row: NativeChatReceiptRow) => boolean {
  const boundaryId = entry.afterMessageId
  const boundaryIndex = boundaryId ? snapshot.boundaries.get(boundaryId) : undefined
  return ({ message, index }) => {
    if (boundaryIndex !== undefined) {
      return index > boundaryIndex
    }
    if (boundaryId === undefined && !glue) {
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

export function nativeChatReceiptDependencyKey(dependency: NativeChatReceiptDependency): string {
  return JSON.stringify([
    nativeChatSourceReceiptKey(dependency.receipt),
    dependency.proof,
    dependency.members
  ])
}

export function liveNativeChatReceiptDependencies(
  pending: readonly NativeChatPendingSend[]
): NativeChatReceiptDependency[] {
  const byId = new Map(pending.map((entry) => [entry.id, entry]))
  const dependencies = new Map<string, NativeChatReceiptDependency>()
  for (const entry of pending) {
    for (const dependency of entry.receiptDependencies ?? []) {
      if (
        dependency.members.every((id) => {
          const member = byId.get(id)
          return (
            member &&
            member.sourceReceipt?.sessionId !== dependency.receipt.sessionId &&
            (dependency.proof === 'source'
              ? !!member.sourceAgent
              : !member.sourceAgent || member.evidenceModePending)
          )
        })
      ) {
        dependencies.set(nativeChatReceiptDependencyKey(dependency), dependency)
      }
    }
  }
  return [...dependencies.values()]
}

export function releaseNativeChatReceiptDependencies<T extends NativeChatPendingSend>(
  pending: T[]
): T[] {
  const live = new Set(liveNativeChatReceiptDependencies(pending))
  let changed = false
  const next = pending.map((entry) => {
    if (!entry.receiptDependencies?.some((dependency) => !live.has(dependency))) {
      return entry
    }
    changed = true
    const dependencies = entry.receiptDependencies.filter((dependency) => live.has(dependency))
    return { ...entry, receiptDependencies: dependencies.length ? dependencies : undefined }
  })
  return changed ? next : pending
}
