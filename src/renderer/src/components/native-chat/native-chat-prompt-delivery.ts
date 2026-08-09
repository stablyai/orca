import type { AgentPromptSubmissionOccurrence } from '../../../../shared/agent-status-types'
import { sha256 } from '../../lib/sha256'

export const NATIVE_CHAT_DELIVERY_CONFIRMATION_MS = 8_000

export type NativeChatDeliveryCheck = {
  expectedDigest?: string
  baseline?: AgentPromptSubmissionOccurrence
  submittedAt?: number
  deadline?: number
  acknowledgedBy?: AgentPromptSubmissionOccurrence
}

type NativeChatDeliveryCandidate = {
  id: string
  deliveryCheck?: NativeChatDeliveryCheck
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function nativeChatPromptDigest(text: string): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(text)))}`
}

export function armNativeChatDeliveryCheck(
  check: NativeChatDeliveryCheck,
  submittedAt: number
): NativeChatDeliveryCheck {
  return {
    ...check,
    submittedAt,
    deadline: submittedAt + NATIVE_CHAT_DELIVERY_CONFIRMATION_MS
  }
}

function occurrenceIsNewer(
  occurrence: AgentPromptSubmissionOccurrence,
  check: NativeChatDeliveryCheck
): boolean {
  if (check.baseline) {
    return check.baseline.streamId === occurrence.streamId
      ? occurrence.sequence > check.baseline.sequence
      : occurrence.receivedAt > check.baseline.receivedAt
  }
  return check.submittedAt !== undefined && occurrence.receivedAt >= check.submittedAt
}

export function hasMatchingPromptSubmission(
  check: NativeChatDeliveryCheck,
  occurrences: readonly AgentPromptSubmissionOccurrence[]
): boolean {
  return (
    check.expectedDigest !== undefined &&
    occurrences.some(
      (occurrence) =>
        occurrence.digest === check.expectedDigest && occurrenceIsNewer(occurrence, check)
    )
  )
}

function occurrenceKey(occurrence: AgentPromptSubmissionOccurrence): string {
  return `${occurrence.streamId}\0${occurrence.sequence}`
}

/** Assign each hook occurrence to at most one pending send. */
export function assignMatchingPromptSubmissions(
  candidates: readonly NativeChatDeliveryCandidate[],
  occurrences: readonly AgentPromptSubmissionOccurrence[]
): Map<string, AgentPromptSubmissionOccurrence> {
  const assignments = new Map<string, AgentPromptSubmissionOccurrence>()
  const claimed = new Set<string>()
  for (const candidate of candidates) {
    const acknowledgedBy = candidate.deliveryCheck?.acknowledgedBy
    if (acknowledgedBy) {
      assignments.set(candidate.id, acknowledgedBy)
      claimed.add(occurrenceKey(acknowledgedBy))
    }
  }
  for (const candidate of candidates) {
    const check = candidate.deliveryCheck
    if (!check || check.acknowledgedBy) {
      continue
    }
    const occurrence = occurrences.find(
      (item) => !claimed.has(occurrenceKey(item)) && hasMatchingPromptSubmission(check, [item])
    )
    if (occurrence) {
      assignments.set(candidate.id, occurrence)
      claimed.add(occurrenceKey(occurrence))
    }
  }
  return assignments
}
