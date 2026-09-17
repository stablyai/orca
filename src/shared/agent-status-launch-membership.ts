/**
 * Host-owned membership for an execution that Orca committed or adopted.
 *
 * Membership is deliberately separate from the legacy status state. A row can
 * therefore be present before a provider has emitted a turn observation without
 * manufacturing `working`, `waiting`, or completion evidence.
 */

import type { AgentStatusExecutionBinding } from './agent-status-run'

/** C5's canonical binding; C10 stores and projects it but never mints one. */
export type AgentStatusLaunchBinding = AgentStatusExecutionBinding

export type AgentStatusLaunchMembership = {
  binding: AgentStatusLaunchBinding
  disposition: 'created' | 'adopted'
  phase: 'committed' | 'unconfirmed'
  committedAt: number
}

const MAX_ID_LENGTH = 128

function isBoundedId(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseAgentStatusLaunchBinding(value: unknown): AgentStatusLaunchBinding | null {
  if (!isRecord(value)) {
    return null
  }
  const attachment = value.attachment
  if (
    !isRecord(attachment) ||
    !isBoundedId(value.runId) ||
    !isBoundedId(attachment.executionId) ||
    (value.role !== 'root' && value.role !== 'child')
  ) {
    return null
  }
  if (value.continuityOf !== undefined && !isBoundedId(value.continuityOf)) {
    return null
  }
  return {
    runId: value.runId,
    attachment: { executionId: attachment.executionId },
    role: value.role,
    ...(value.continuityOf !== undefined ? { continuityOf: value.continuityOf } : {})
  }
}

export function parseAgentStatusLaunchMembership(
  value: unknown
): AgentStatusLaunchMembership | null {
  if (!isRecord(value)) {
    return null
  }
  const binding = parseAgentStatusLaunchBinding(value.binding)
  if (
    !binding ||
    (value.disposition !== 'created' && value.disposition !== 'adopted') ||
    (value.phase !== 'committed' && value.phase !== 'unconfirmed') ||
    typeof value.committedAt !== 'number' ||
    !Number.isFinite(value.committedAt) ||
    value.committedAt <= 0
  ) {
    return null
  }
  return {
    binding,
    disposition: value.disposition,
    phase: value.phase,
    committedAt: value.committedAt
  }
}

export function launchMembershipsEqual(
  left: AgentStatusLaunchMembership,
  right: AgentStatusLaunchMembership
): boolean {
  return (
    left.binding.runId === right.binding.runId &&
    left.binding.attachment.executionId === right.binding.attachment.executionId &&
    left.binding.role === right.binding.role &&
    left.binding.continuityOf === right.binding.continuityOf
  )
}
