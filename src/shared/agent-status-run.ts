import { isAgentHookSource, type AgentHookSource } from './agent-hook-relay'
import type { AgentProviderSessionKey } from './agent-session-resume'

export const AGENT_STATUS_PROVIDER_SESSION_CHAIN_MAX = 256

const MAX_RUN_ID_LENGTH = 128

const MAX_EXECUTION_ID_LENGTH = 128

const MAX_PANE_KEY_LENGTH = 512

const MAX_PROVIDER_ID_LENGTH = 512

export type AgentStatusRunId = string

export type AgentStatusExecutionId = string

/** Public handle for one host-observed process incarnation; process evidence stays host-private. */
export type AgentStatusExecutionAttachment = {
  executionId: AgentStatusExecutionId
}

export type AgentStatusProviderAlias = {
  provider: AgentHookSource
  sessionKeyKind: AgentProviderSessionKey
  providerId: string
}

/** Ordered provider identity evidence reported by one run. */
export type AgentStatusProviderSession = AgentStatusProviderAlias & {
  /** Marks that this link followed a provider reset boundary such as Claude `/clear`. */
  resetBoundary?: true
}

export type AgentStatusRunAttribution = 'token' | 'pane'

export type AgentStatusRunRole = 'root' | 'child' | 'unresolved'

export type AgentStatusRunVerdict = 'live' | 'unverifiable' | 'exited'

/** Identity and lifecycle fields carried by a canonical `pty-run` status row. */
export type AgentStatusPtyRunRecord = {
  runId: AgentStatusRunId
  paneKey: string
  attachment: AgentStatusExecutionAttachment
  attribution: AgentStatusRunAttribution
  providerSessions: AgentStatusProviderSession[]
  continuityOf?: AgentStatusRunId
  role: AgentStatusRunRole
  verdict: AgentStatusRunVerdict
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
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

function isBoundedIdentity(value: unknown, maxLength: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim()
  ) {
    return false
  }

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)

    if (code <= 0x1f || code === 0x7f) {
      return false
    }
  }

  return true
}

export function isAgentStatusRunId(value: unknown): value is AgentStatusRunId {
  return isBoundedIdentity(value, MAX_RUN_ID_LENGTH)
}

export function isAgentStatusExecutionId(value: unknown): value is AgentStatusExecutionId {
  return isBoundedIdentity(value, MAX_EXECUTION_ID_LENGTH)
}

function parseExecutionAttachment(value: unknown): AgentStatusExecutionAttachment | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['executionId']) ||
    !isAgentStatusExecutionId(value.executionId)
  ) {
    return null
  }

  return { executionId: value.executionId }
}

export function parseAgentStatusProviderAlias(value: unknown): AgentStatusProviderAlias | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['provider', 'sessionKeyKind', 'providerId']) ||
    !isAgentHookSource(value.provider) ||
    (value.sessionKeyKind !== 'session_id' && value.sessionKeyKind !== 'conversation_id') ||
    !isBoundedIdentity(value.providerId, MAX_PROVIDER_ID_LENGTH) ||
    value.providerId.startsWith('-')
  ) {
    return null
  }

  return {
    provider: value.provider,
    sessionKeyKind: value.sessionKeyKind,
    providerId: value.providerId
  }
}

function parseProviderSession(value: unknown): AgentStatusProviderSession | null {
  const hasResetBoundary = isRecord(value) && Object.hasOwn(value, 'resetBoundary')

  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['provider', 'sessionKeyKind', 'providerId'], ['resetBoundary']) ||
    (hasResetBoundary && value.resetBoundary !== true)
  ) {
    return null
  }

  const alias = parseAgentStatusProviderAlias({
    provider: value.provider,
    sessionKeyKind: value.sessionKeyKind,
    providerId: value.providerId
  })

  if (!alias) {
    return null
  }

  return hasResetBoundary ? { ...alias, resetBoundary: true } : alias
}

function parseProviderSessions(value: unknown): AgentStatusProviderSession[] | null {
  if (!Array.isArray(value) || value.length > AGENT_STATUS_PROVIDER_SESSION_CHAIN_MAX) {
    return null
  }

  const sessions: AgentStatusProviderSession[] = []

  for (const candidate of value) {
    const session = parseProviderSession(candidate)

    if (!session) {
      return null
    }

    sessions.push(session)
  }

  const provider = sessions[0]?.provider

  if (provider && sessions.some((session) => session.provider !== provider)) {
    return null
  }

  return sessions
}

export function parseAgentStatusPtyRunRecord(value: unknown): AgentStatusPtyRunRecord | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['runId', 'paneKey', 'attachment', 'attribution', 'providerSessions', 'role', 'verdict'],
      ['continuityOf']
    ) ||
    !isAgentStatusRunId(value.runId) ||
    !isBoundedIdentity(value.paneKey, MAX_PANE_KEY_LENGTH) ||
    (value.attribution !== 'token' && value.attribution !== 'pane') ||
    (value.role !== 'root' && value.role !== 'child' && value.role !== 'unresolved') ||
    (value.verdict !== 'live' && value.verdict !== 'unverifiable' && value.verdict !== 'exited')
  ) {
    return null
  }

  const attachment = parseExecutionAttachment(value.attachment)
  const providerSessions = parseProviderSessions(value.providerSessions)
  const hasContinuity = Object.hasOwn(value, 'continuityOf')

  if (
    !attachment ||
    !providerSessions ||
    (hasContinuity &&
      (!isAgentStatusRunId(value.continuityOf) || value.continuityOf === value.runId))
  ) {
    return null
  }

  return {
    runId: value.runId,
    paneKey: value.paneKey,
    attachment,
    attribution: value.attribution,
    providerSessions,
    ...(hasContinuity && isAgentStatusRunId(value.continuityOf)
      ? { continuityOf: value.continuityOf }
      : {}),
    role: value.role,
    verdict: value.verdict
  }
}

export function serializeAgentStatusPtyRunRecord(record: AgentStatusPtyRunRecord): string {
  const parsed = parseAgentStatusPtyRunRecord(record)

  if (!parsed) {
    throw new Error('Invalid PTY run status record')
  }

  return JSON.stringify(parsed)
}

export function deserializeAgentStatusPtyRunRecord(value: string): AgentStatusPtyRunRecord | null {
  try {
    return parseAgentStatusPtyRunRecord(JSON.parse(value))
  } catch {
    return null
  }
}
