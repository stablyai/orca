import {
  isAgentSessionDeathEvidence,
  type AgentSessionDeathEvidence
} from './agent-session-death-evidence'
export const MAX_JOURNAL_RETIREMENT_TARGETS = 512
export const MAX_JOURNAL_RETIREMENT_CAPTURE_BYTES = 256_000

export type JournalRetirementItem = {
  itemId: string
  revision: number
  mutationSequence: number
  aliases: readonly { itemId: string; mutationSequence: number }[]
}
export type JournalRetirementSubmission = {
  clientMessageId: string
  mutationSequence: number
}
export type JournalRetirementCapture = {
  sessionId: string
  epoch: string
  incarnation: string
  throughSequence: number
  items: readonly JournalRetirementItem[]
  submissions: readonly JournalRetirementSubmission[]
}

export const MAX_AGENT_SESSION_RETIREMENT_RECEIPTS = 8
export const AGENT_SESSION_RETIREMENT_TTL_MS = 24 * 60 * 60 * 1000
export type AgentSessionRetirementReceipt = {
  id: string
  fence: number
  observedAt: number
  evidence?: AgentSessionDeathEvidence
  capture: JournalRetirementCapture
}
export type AgentSessionRetirements = {
  receipts: AgentSessionRetirementReceipt[]
  lastCapturedFence?: number
  abandonedCount: number
  lastAbandonedAt?: number
  lastAbandonedReason?: 'unreadable' | 'quota' | 'expired'
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function item(value: unknown): value is JournalRetirementItem {
  return (
    object(value) &&
    id(value.itemId) &&
    integer(value.revision) &&
    integer(value.mutationSequence) &&
    Array.isArray(value.aliases) &&
    value.aliases.length <= MAX_JOURNAL_RETIREMENT_TARGETS &&
    value.aliases.every(
      (alias: unknown) => object(alias) && id(alias.itemId) && integer(alias.mutationSequence)
    )
  )
}
function submission(value: unknown): value is JournalRetirementSubmission {
  return object(value) && id(value.clientMessageId) && integer(value.mutationSequence)
}
function capture(value: unknown): value is JournalRetirementCapture {
  return (
    object(value) &&
    id(value.sessionId) &&
    id(value.epoch) &&
    id(value.incarnation) &&
    integer(value.throughSequence) &&
    Array.isArray(value.items) &&
    Array.isArray(value.submissions) &&
    value.items.length + value.submissions.length <= MAX_JOURNAL_RETIREMENT_TARGETS &&
    value.items.every(item) &&
    value.submissions.every(submission) &&
    JSON.stringify(value).length <= MAX_JOURNAL_RETIREMENT_CAPTURE_BYTES
  )
}
export function isAgentSessionRetirements(value: unknown): value is AgentSessionRetirements {
  return (
    object(value) &&
    integer(value.abandonedCount) &&
    (value.lastCapturedFence === undefined || integer(value.lastCapturedFence)) &&
    (value.lastAbandonedAt === undefined || integer(value.lastAbandonedAt)) &&
    (value.lastAbandonedReason === undefined ||
      value.lastAbandonedReason === 'unreadable' ||
      value.lastAbandonedReason === 'quota' ||
      value.lastAbandonedReason === 'expired') &&
    Array.isArray(value.receipts) &&
    value.receipts.length <= MAX_AGENT_SESSION_RETIREMENT_RECEIPTS &&
    value.receipts.every(
      (receipt: unknown) =>
        object(receipt) &&
        id(receipt.id) &&
        integer(receipt.fence) &&
        integer(receipt.observedAt) &&
        (receipt.evidence === undefined || isAgentSessionDeathEvidence(receipt.evidence)) &&
        capture(receipt.capture)
    )
  )
}
