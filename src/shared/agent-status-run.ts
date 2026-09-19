import { isAgentHookSource, type AgentHookSource } from './agent-hook-relay'
import type { AgentProviderSessionKey } from './agent-session-resume'
import {
  hasExactKeys,
  isAgentStatusRunId,
  isBoundedIdentity,
  isRecord,
  parseAgentStatusExecutionAttachment,
  type AgentStatusExecutionAttachment,
  type AgentStatusRunId,
  type AgentStatusRunRole
} from './agent-status-execution-binding'

// Execution identity lives in `agent-status-execution-binding.ts` so the ownership layer can reach it
// without this module's hook-wire dependency. Re-exported here for existing run-record consumers.
export {
  agentStatusExecutionBindingEnv,
  isAgentStatusExecutionId,
  isAgentStatusRunId,
  ORCA_AGENT_STATUS_EXECUTION_ID_ENV,
  ORCA_AGENT_STATUS_RUN_ID_ENV,
  parseAgentStatusExecutionBinding,
  parseAgentStatusReportedExecutionBinding,
  type AgentStatusExecutionAttachment,
  type AgentStatusExecutionBinding,
  type AgentStatusExecutionId,
  type AgentStatusReportedExecutionBinding,
  type AgentStatusRunId,
  type AgentStatusRunRole
} from './agent-status-execution-binding'

export const AGENT_STATUS_PROVIDER_SESSION_CHAIN_MAX = 256

const MAX_PANE_KEY_LENGTH = 512
const MAX_PROVIDER_ID_LENGTH = 512

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

export type AgentStatusRunAttribution =
  | 'execution-attachment'
  | 'provider-alias'
  | 'unresolved'
  /** Second-class subject for an agent Orca did not launch, or one behind a multiplexer. */
  | 'pane'
  /** @deprecated Legacy persisted records; never use for newly emitted rows. */
  | 'token'
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
    (value.attribution !== 'execution-attachment' &&
      value.attribution !== 'provider-alias' &&
      value.attribution !== 'unresolved' &&
      value.attribution !== 'token' &&
      value.attribution !== 'pane') ||
    (value.role !== 'root' && value.role !== 'child' && value.role !== 'unresolved') ||
    (value.verdict !== 'live' && value.verdict !== 'unverifiable' && value.verdict !== 'exited')
  ) {
    return null
  }
  const attachment = parseAgentStatusExecutionAttachment(value.attachment)
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
