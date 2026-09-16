import type { AgentStatusIpcPayload } from './agent-status-ipc-payload'
import { parseAgentStatusPtyRunRecord, type AgentStatusPtyRunRecord } from './agent-status-run'
import { parseAgentStatusIpcPayloadCopy } from './agent-status-store-status-codec'
import { parseAgentStatusSubject, type AgentStatusSubject } from './agent-status-subject'

export type AgentStatusParentInput = {
  subject: AgentStatusSubject
  status?: AgentStatusIpcPayload
  run?: AgentStatusPtyRunRecord
  firstObservedAt?: number
}

export type AgentStatusParentRecord = AgentStatusParentInput & { revision: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(record)
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  )
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isParentScopeConsistent(parent: AgentStatusParentInput): boolean {
  const { subject, status, run } = parent
  if (run && (subject.kind !== 'pty-run' || run.runId !== subject.runId)) {
    return false
  }
  if (
    subject.kind !== 'pty-run' &&
    (status?.runId !== undefined || status?.executionId !== undefined)
  ) {
    return false
  }
  if (status?.worktreeId !== undefined && status.worktreeId !== subject.workspaceId) {
    return false
  }
  if (subject.kind === 'pty' && status?.paneKey !== subject.paneKey) {
    return false
  }
  if (subject.kind === 'pty-run' && status?.runId !== undefined && status.runId !== subject.runId) {
    return false
  }
  if (run && status?.paneKey !== undefined && status.paneKey !== run.paneKey) {
    return false
  }
  if (
    run &&
    status?.executionId !== undefined &&
    status.executionId !== run.attachment.executionId
  ) {
    return false
  }
  if (
    run &&
    status?.providerAlias &&
    run.providerSessions.length > 0 &&
    !run.providerSessions.some(
      (session) =>
        session.provider === status.providerAlias?.provider &&
        session.sessionKeyKind === status.providerAlias.sessionKeyKind &&
        session.providerId === status.providerAlias.providerId
    )
  ) {
    return false
  }
  return true
}

export function parseAgentStatusParentInput(value: unknown): AgentStatusParentInput | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['subject'], ['status', 'run', 'firstObservedAt']) ||
    (value.firstObservedAt !== undefined && !isTimestamp(value.firstObservedAt))
  ) {
    return null
  }
  const subject = parseAgentStatusSubject(value.subject)
  const status =
    value.status === undefined ? undefined : parseAgentStatusIpcPayloadCopy(value.status)
  const run = value.run === undefined ? undefined : parseAgentStatusPtyRunRecord(value.run)
  if (!subject || (value.status !== undefined && !status) || (value.run !== undefined && !run)) {
    return null
  }
  const parent: AgentStatusParentInput = {
    subject,
    ...(status ? { status } : {}),
    ...(run ? { run } : {}),
    ...(isTimestamp(value.firstObservedAt) ? { firstObservedAt: value.firstObservedAt } : {})
  }
  return isParentScopeConsistent(parent) ? parent : null
}

export function parseAgentStatusParentRecord(value: unknown): AgentStatusParentRecord | null {
  if (!isRecord(value) || !isRevision(value.revision)) {
    return null
  }
  const input = { ...value }
  delete input.revision
  const parent = parseAgentStatusParentInput(input)
  return parent ? { ...parent, revision: value.revision } : null
}
