import type {
  AgentSessionExecutionLocation,
  AgentSessionWorkspaceKind
} from './agent-session-record'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import { parseWorkspaceKey } from './workspace-scope'
import { splitWorktreeIdForFilesystem } from './worktree/id'
import { parseWslUncPath } from './wsl-paths'
import {
  isWslHookRelayConnectionId,
  WSL_HOOK_RELAY_CONNECTION_PREFIX
} from './wsl-hook-relay-contract'

const MAX_SCOPE_PART_LENGTH = 512
const UNATTRIBUTED_WORKSPACE_ID = 'agent-status-unattributed'
const SUBJECT_KEY_PREFIX = 'agent-status-subject-v1:'
const AGENT_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

export type AgentStatusExecutionScope = AgentSessionExecutionLocation

export type AgentStatusSubject =
  | (AgentStatusExecutionScope & { kind: 'pty'; paneKey: string })
  | (AgentStatusExecutionScope & { kind: 'structured-session'; sessionId: string })

type AgentStatusSubjectKeyTuple = readonly [
  kind: AgentStatusSubject['kind'],
  executionHostId: ExecutionHostId,
  wslDistro: string | null,
  workspaceId: string,
  workspaceKind: AgentSessionWorkspaceKind,
  identity: string
]

function isScopePart(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SCOPE_PART_LENGTH &&
    !value.includes('\0')
  )
}

function isAgentStatusSessionId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_SESSION_ID_PATTERN.test(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

/** Parse and validate an untrusted status subject without silently normalizing its identity. */
export function parseAgentStatusSubject(value: unknown): AgentStatusSubject | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const subject = value as Record<string, unknown>
  if (
    !hasOnlyKeys(subject, [
      'kind',
      'executionHostId',
      'wslDistro',
      'workspaceId',
      'workspaceKind',
      'paneKey',
      'sessionId'
    ]) ||
    !parseExecutionHostId(
      typeof subject.executionHostId === 'string' ? subject.executionHostId : undefined
    ) ||
    (subject.wslDistro !== null && !isScopePart(subject.wslDistro)) ||
    !isScopePart(subject.workspaceId) ||
    (subject.workspaceKind !== 'git-worktree' && subject.workspaceKind !== 'folder')
  ) {
    return null
  }
  const scope: AgentStatusExecutionScope = {
    executionHostId: subject.executionHostId as ExecutionHostId,
    wslDistro: subject.wslDistro as string | null,
    workspaceId: subject.workspaceId,
    workspaceKind: subject.workspaceKind
  }
  if (subject.kind === 'pty' && isScopePart(subject.paneKey) && subject.sessionId === undefined) {
    return { kind: 'pty', ...scope, paneKey: subject.paneKey }
  }
  if (
    subject.kind === 'structured-session' &&
    isAgentStatusSessionId(subject.sessionId) &&
    subject.paneKey === undefined
  ) {
    return { kind: 'structured-session', ...scope, sessionId: subject.sessionId }
  }
  return null
}

export function isAgentStatusSubject(value: unknown): value is AgentStatusSubject {
  return parseAgentStatusSubject(value) !== null
}

function subjectKeyTuple(subject: AgentStatusSubject): AgentStatusSubjectKeyTuple {
  return [
    subject.kind,
    subject.executionHostId,
    subject.wslDistro,
    subject.workspaceId,
    subject.workspaceKind,
    subject.kind === 'pty' ? subject.paneKey : subject.sessionId
  ]
}

/** Stable collision-free identity for in-process maps; it is not a wire or persistence key. */
export function agentStatusSubjectKey(subject: AgentStatusSubject): string {
  const parsed = parseAgentStatusSubject(subject)
  if (!parsed) {
    throw new Error('Invalid agent status subject')
  }
  return `${SUBJECT_KEY_PREFIX}${JSON.stringify(subjectKeyTuple(parsed))}`
}

export function parseAgentStatusSubjectKey(value: string): AgentStatusSubject | null {
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
  return parseAgentStatusSubject(
    kind === 'pty'
      ? { kind, executionHostId, wslDistro, workspaceId, workspaceKind, paneKey: identity }
      : { kind, executionHostId, wslDistro, workspaceId, workspaceKind, sessionId: identity }
  )
}

export function agentStatusSubjectsEqual(
  left: AgentStatusSubject,
  right: AgentStatusSubject
): boolean {
  return agentStatusSubjectKey(left) === agentStatusSubjectKey(right)
}

export function makePtyAgentStatusSubject(
  scope: AgentStatusExecutionScope,
  paneKey: string
): AgentStatusSubject {
  const subject = parseAgentStatusSubject({ kind: 'pty', ...scope, paneKey })
  if (!subject) {
    throw new Error('Invalid PTY agent status subject')
  }
  return subject
}

export function makeStructuredAgentStatusSubject(
  scope: AgentStatusExecutionScope,
  sessionId: string
): AgentStatusSubject {
  const subject = parseAgentStatusSubject({ kind: 'structured-session', ...scope, sessionId })
  if (!subject) {
    throw new Error('Invalid structured agent status subject')
  }
  return subject
}

/** Compatibility adapter for pane-key-only hook, IPC, and persisted rows. */
export function agentStatusSubjectFromLegacyPane(args: {
  paneKey: string
  worktreeId?: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId
  wslDistro?: string | null
  workspaceKind?: AgentSessionWorkspaceKind
}): AgentStatusSubject {
  const connectionId = args.connectionId?.trim() || null
  const relayDistro = isWslHookRelayConnectionId(connectionId)
    ? connectionId!.slice(WSL_HOOK_RELAY_CONNECTION_PREFIX.length).trim() || null
    : null
  const worktreePath = args.worktreeId
    ? (splitWorktreeIdForFilesystem(args.worktreeId)?.worktreePath ?? args.worktreeId)
    : null
  const worktreeDistro = worktreePath ? (parseWslUncPath(worktreePath)?.distro ?? null) : null
  const executionHostId =
    args.executionHostId ??
    (connectionId && !relayDistro ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID)
  const workspaceId = args.worktreeId?.trim() || UNATTRIBUTED_WORKSPACE_ID
  const workspaceKind =
    args.workspaceKind ??
    (parseWorkspaceKey(workspaceId)?.type === 'folder' ? 'folder' : 'git-worktree')
  return makePtyAgentStatusSubject(
    {
      executionHostId,
      wslDistro: args.wslDistro ?? relayDistro ?? worktreeDistro,
      workspaceId,
      workspaceKind
    },
    args.paneKey
  )
}
