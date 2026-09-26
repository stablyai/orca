import { isAgentSessionId, type AgentSessionExecutionLocation } from './agent-session-record'
import { isAgentStatusRunId, type AgentStatusRunId } from './agent-status-run'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from './execution-host'

const SUBJECT_KEY_PREFIX = 'agent-status-subject-v1:'
const MAX_SCOPE_PART_LENGTH = 512
const MAX_PANE_KEY_LENGTH = 512

export type AgentStatusExecutionScope = AgentSessionExecutionLocation

export type AgentStatusPtyRunSubject = AgentStatusExecutionScope & {
  kind: 'pty-run'
  runId: AgentStatusRunId
}

export type AgentStatusPtySubject = AgentStatusExecutionScope & {
  kind: 'pty'
  paneKey: string
}

export type AgentStatusStructuredSessionSubject = AgentStatusExecutionScope & {
  kind: 'structured-session'
  sessionId: string
}

export type AgentStatusSubject =
  | AgentStatusPtyRunSubject
  | AgentStatusPtySubject
  | AgentStatusStructuredSessionSubject

type AgentStatusSubjectKeyTuple = readonly [
  kind: AgentStatusSubject['kind'],
  executionHostId: string,
  wslDistro: string | null,
  workspaceId: string,
  workspaceKind: AgentStatusExecutionScope['workspaceKind'],
  identity: string
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(record)
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key))
}

function isBoundedIdentity(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !value.includes('\0')
  )
}

function parseExecutionScope(record: Record<string, unknown>): AgentStatusExecutionScope | null {
  if (!isBoundedIdentity(record.executionHostId, MAX_SCOPE_PART_LENGTH)) {
    return null
  }
  const parsedHost = parseExecutionHostId(record.executionHostId)
  const canonicalHostId =
    parsedHost?.kind === 'ssh'
      ? toSshExecutionHostId(parsedHost.targetId)
      : parsedHost?.kind === 'runtime'
        ? toRuntimeExecutionHostId(parsedHost.environmentId)
        : parsedHost?.id
  if (
    !parsedHost ||
    canonicalHostId !== record.executionHostId ||
    (parsedHost.kind !== 'local' && record.wslDistro !== null) ||
    (record.wslDistro !== null && !isBoundedIdentity(record.wslDistro, MAX_SCOPE_PART_LENGTH)) ||
    !isBoundedIdentity(record.workspaceId, MAX_SCOPE_PART_LENGTH) ||
    (record.workspaceKind !== 'git-worktree' && record.workspaceKind !== 'folder')
  ) {
    return null
  }
  return {
    executionHostId: parsedHost.id,
    wslDistro: record.wslDistro,
    workspaceId: record.workspaceId,
    workspaceKind: record.workspaceKind
  }
}

export function parseAgentStatusExecutionScope(value: unknown): AgentStatusExecutionScope | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['executionHostId', 'wslDistro', 'workspaceId', 'workspaceKind'])
  ) {
    return null
  }
  return parseExecutionScope(value)
}

/** Strictly decode an untrusted subject without trimming or dropping unknown fields. */
export function parseAgentStatusSubject(value: unknown): AgentStatusSubject | null {
  if (!isRecord(value)) {
    return null
  }
  const scope = parseExecutionScope(value)
  if (!scope) {
    return null
  }
  if (
    value.kind === 'pty-run' &&
    hasExactKeys(value, [
      'kind',
      'executionHostId',
      'wslDistro',
      'workspaceId',
      'workspaceKind',
      'runId'
    ]) &&
    isAgentStatusRunId(value.runId)
  ) {
    return { ...scope, kind: 'pty-run', runId: value.runId }
  }
  if (
    value.kind === 'pty' &&
    hasExactKeys(value, [
      'kind',
      'executionHostId',
      'wslDistro',
      'workspaceId',
      'workspaceKind',
      'paneKey'
    ]) &&
    isBoundedIdentity(value.paneKey, MAX_PANE_KEY_LENGTH)
  ) {
    return { ...scope, kind: 'pty', paneKey: value.paneKey }
  }
  if (
    value.kind === 'structured-session' &&
    hasExactKeys(value, [
      'kind',
      'executionHostId',
      'wslDistro',
      'workspaceId',
      'workspaceKind',
      'sessionId'
    ]) &&
    isAgentSessionId(value.sessionId)
  ) {
    return { ...scope, kind: 'structured-session', sessionId: value.sessionId }
  }
  return null
}

export function isAgentStatusSubject(value: unknown): value is AgentStatusSubject {
  return parseAgentStatusSubject(value) !== null
}

function subjectKeyTuple(subject: AgentStatusSubject): AgentStatusSubjectKeyTuple {
  const identity =
    subject.kind === 'pty-run'
      ? subject.runId
      : subject.kind === 'pty'
        ? subject.paneKey
        : subject.sessionId
  return [
    subject.kind,
    subject.executionHostId,
    subject.wslDistro,
    subject.workspaceId,
    subject.workspaceKind,
    identity
  ]
}

// Stored subjects are frozen, and the status store keys every record by one on each mutation.
const frozenSubjectKeys = new WeakMap<AgentStatusSubject, string>()

/** Stable serialized identity for maps, persistence, and snapshot transport. */
export function serializeAgentStatusSubject(subject: AgentStatusSubject): string {
  const cached = frozenSubjectKeys.get(subject)
  if (cached !== undefined) {
    return cached
  }
  const parsed = parseAgentStatusSubject(subject)
  if (!parsed) {
    throw new Error('Invalid agent status subject')
  }
  const key = `${SUBJECT_KEY_PREFIX}${JSON.stringify(subjectKeyTuple(parsed))}`
  if (Object.isFrozen(subject)) {
    frozenSubjectKeys.set(subject, key)
  }
  return key
}

export function deserializeAgentStatusSubject(value: string): AgentStatusSubject | null {
  if (!value.startsWith(SUBJECT_KEY_PREFIX)) {
    return null
  }
  let tuple: unknown
  try {
    tuple = JSON.parse(value.slice(SUBJECT_KEY_PREFIX.length))
  } catch {
    return null
  }
  if (!Array.isArray(tuple) || tuple.length !== 6) {
    return null
  }
  const [kind, executionHostId, wslDistro, workspaceId, workspaceKind, identity] = tuple
  if (kind === 'pty-run') {
    return parseAgentStatusSubject({
      kind,
      executionHostId,
      wslDistro,
      workspaceId,
      workspaceKind,
      runId: identity
    })
  }
  if (kind === 'pty') {
    return parseAgentStatusSubject({
      kind,
      executionHostId,
      wslDistro,
      workspaceId,
      workspaceKind,
      paneKey: identity
    })
  }
  if (kind === 'structured-session') {
    return parseAgentStatusSubject({
      kind,
      executionHostId,
      wslDistro,
      workspaceId,
      workspaceKind,
      sessionId: identity
    })
  }
  return null
}

export const agentStatusSubjectKey = serializeAgentStatusSubject
export const parseAgentStatusSubjectKey = deserializeAgentStatusSubject

export function agentStatusSubjectsEqual(
  left: AgentStatusSubject,
  right: AgentStatusSubject
): boolean {
  return serializeAgentStatusSubject(left) === serializeAgentStatusSubject(right)
}

export function makePtyRunAgentStatusSubject(
  scope: AgentStatusExecutionScope,
  runId: AgentStatusRunId
): AgentStatusPtyRunSubject {
  const subject = parseAgentStatusSubject({ ...scope, kind: 'pty-run', runId })
  if (!subject || subject.kind !== 'pty-run') {
    throw new Error('Invalid PTY run agent status subject')
  }
  return subject
}

export function makePtyAgentStatusSubject(
  scope: AgentStatusExecutionScope,
  paneKey: string
): AgentStatusPtySubject {
  const subject = parseAgentStatusSubject({ ...scope, kind: 'pty', paneKey })
  if (!subject || subject.kind !== 'pty') {
    throw new Error('Invalid PTY fallback agent status subject')
  }
  return subject
}

export function makeStructuredAgentStatusSubject(
  scope: AgentStatusExecutionScope,
  sessionId: string
): AgentStatusStructuredSessionSubject {
  const subject = parseAgentStatusSubject({ ...scope, kind: 'structured-session', sessionId })
  if (!subject || subject.kind !== 'structured-session') {
    throw new Error('Invalid structured agent status subject')
  }
  return subject
}
