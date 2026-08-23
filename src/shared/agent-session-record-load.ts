import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  isAgentSessionRecord,
  type AgentSessionRecord
} from './agent-session-record'

export type AgentSessionRecordLoadResult =
  | { status: 'current'; record: AgentSessionRecord }
  | { status: 'upgraded'; record: AgentSessionRecord }
  | {
      status: 'unusable'
      reason:
        | 'current_shape_invalid'
        | 'unsupported_schema'
        | 'legacy_shape_invalid'
        | 'legacy_provider_handle_missing'
        | 'legacy_provider_handle_is_desktop_session'
        | 'legacy_account_home_provider_mismatch'
    }

function legacyHandleUsesDesktopSessionId(record: AgentSessionRecord): boolean {
  return record.providerHandleChain.some((link) => {
    const providerId =
      link.handle.provider === 'claude' ? link.handle.sessionId : link.handle.threadId
    return providerId === record.sessionId
  })
}

/** V1 covered multiple ad-hoc shapes, so only structurally current, provider-safe rows migrate. */
export function loadAgentSessionRecord(value: unknown): AgentSessionRecordLoadResult {
  if (isAgentSessionRecord(value)) {
    return { status: 'current', record: value }
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { schemaVersion?: unknown }).schemaVersion === AGENT_SESSION_RECORD_SCHEMA_VERSION
  ) {
    return { status: 'unusable', reason: 'current_shape_invalid' }
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    return { status: 'unusable', reason: 'unsupported_schema' }
  }
  const candidate = {
    ...(value as Record<string, unknown>),
    schemaVersion: AGENT_SESSION_RECORD_SCHEMA_VERSION
  }
  if (!isAgentSessionRecord(candidate)) {
    return { status: 'unusable', reason: 'legacy_shape_invalid' }
  }
  if (candidate.providerHandleChain.length === 0) {
    return { status: 'unusable', reason: 'legacy_provider_handle_missing' }
  }
  if (legacyHandleUsesDesktopSessionId(candidate)) {
    return { status: 'unusable', reason: 'legacy_provider_handle_is_desktop_session' }
  }
  const expectedAccountVariable =
    candidate.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
  if (candidate.accountHome.variable !== expectedAccountVariable) {
    return { status: 'unusable', reason: 'legacy_account_home_provider_mismatch' }
  }
  return {
    status: 'upgraded',
    record: {
      ...candidate,
      lease: {
        ...candidate.lease,
        claimStatus: 'conflicted',
        handoffStage: 'manual-recovery',
        unreconciled: true
      }
    }
  }
}
