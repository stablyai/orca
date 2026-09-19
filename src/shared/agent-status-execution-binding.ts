// Why this is separate from `agent-status-run.ts`: execution identity is consumed by the terminal
// ownership layer, which the renderer reaches. The provider-alias half of a run record depends on
// the hook wire envelope, and that module imports `node:crypto`. Keeping the two apart is what stops
// ownership from pulling a main-process-only dependency into the renderer bundle.

const MAX_RUN_ID_LENGTH = 128
const MAX_EXECUTION_ID_LENGTH = 128

export type AgentStatusRunId = string
export type AgentStatusExecutionId = string

export type AgentStatusRunRole = 'root' | 'child' | 'unresolved'

/** Public handle for one host-observed process incarnation; process evidence stays host-private. */
export type AgentStatusExecutionAttachment = {
  executionId: AgentStatusExecutionId
}

/** Identity minted atomically with one committed execution owner. */
export type AgentStatusExecutionBinding = {
  runId: AgentStatusRunId
  attachment: AgentStatusExecutionAttachment
  role: Exclude<AgentStatusRunRole, 'unresolved'>
  continuityOf?: AgentStatusRunId
}

/** Minimal execution claim carried by an emitter; the host resolves the canonical binding. */
export type AgentStatusReportedExecutionBinding = {
  runId: AgentStatusRunId
  executionId: AgentStatusExecutionId
}

export const ORCA_AGENT_STATUS_RUN_ID_ENV = 'ORCA_AGENT_STATUS_RUN_ID' as const
export const ORCA_AGENT_STATUS_EXECUTION_ID_ENV = 'ORCA_AGENT_STATUS_EXECUTION_ID' as const

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hasExactKeys(
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

export function isBoundedIdentity(value: unknown, maxLength: number): value is string {
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

export function parseAgentStatusExecutionAttachment(
  value: unknown
): AgentStatusExecutionAttachment | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['executionId']) ||
    !isAgentStatusExecutionId(value.executionId)
  ) {
    return null
  }
  return { executionId: value.executionId }
}

export function parseAgentStatusReportedExecutionBinding(
  value: unknown
): AgentStatusReportedExecutionBinding | null {
  if (!isRecord(value)) {
    return null
  }
  return isAgentStatusRunId(value.runId) && isAgentStatusExecutionId(value.executionId)
    ? { runId: value.runId, executionId: value.executionId }
    : null
}

export function agentStatusExecutionBindingEnv(
  binding: AgentStatusExecutionBinding
): Record<typeof ORCA_AGENT_STATUS_RUN_ID_ENV | typeof ORCA_AGENT_STATUS_EXECUTION_ID_ENV, string> {
  return {
    [ORCA_AGENT_STATUS_RUN_ID_ENV]: binding.runId,
    [ORCA_AGENT_STATUS_EXECUTION_ID_ENV]: binding.attachment.executionId
  }
}

export function parseAgentStatusExecutionBinding(
  value: unknown
): AgentStatusExecutionBinding | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['runId', 'attachment', 'role'], ['continuityOf']) ||
    !isAgentStatusRunId(value.runId) ||
    (value.role !== 'root' && value.role !== 'child')
  ) {
    return null
  }
  const attachment = parseAgentStatusExecutionAttachment(value.attachment)
  const hasContinuity = Object.hasOwn(value, 'continuityOf')
  if (
    !attachment ||
    (hasContinuity &&
      (!isAgentStatusRunId(value.continuityOf) || value.continuityOf === value.runId))
  ) {
    return null
  }
  return {
    runId: value.runId,
    attachment,
    role: value.role,
    ...(hasContinuity && isAgentStatusRunId(value.continuityOf)
      ? { continuityOf: value.continuityOf }
      : {})
  }
}
