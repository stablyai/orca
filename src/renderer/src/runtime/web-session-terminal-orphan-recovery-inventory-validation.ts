import type { RuntimeTerminalListResult } from '../../../shared/runtime-types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Accept only complete inventory envelopes; an incomplete answer cannot prove a PTY exited. */
export function isTerminalListResult(value: unknown): value is RuntimeTerminalListResult {
  if (
    !isRecord(value) ||
    !Array.isArray(value.terminals) ||
    typeof value.totalCount !== 'number' ||
    !Number.isFinite(value.totalCount) ||
    value.totalCount < 0 ||
    typeof value.truncated !== 'boolean'
  ) {
    return false
  }
  if (
    value.terminals.some(
      (terminal) => !isRecord(terminal) || typeof terminal.handle !== 'string' || !terminal.handle
    )
  ) {
    return false
  }
  const hostScope = value.hostScope
  if (
    hostScope !== undefined &&
    (!isRecord(hostScope) ||
      !isStringArray(hostScope.hostIds) ||
      !isStringArray(hostScope.omittedHostIds))
  ) {
    return false
  }
  const topologyRevisions = value.topologyRevisions
  return (
    topologyRevisions === undefined ||
    (isRecord(topologyRevisions) &&
      Object.values(topologyRevisions).every(
        (revision) => typeof revision === 'number' && Number.isFinite(revision) && revision >= 0
      ))
  )
}
