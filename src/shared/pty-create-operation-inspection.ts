import { isPtyIncarnationId } from './pty-incarnation'

export const AGENT_SESSION_CREATE_OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function parsePtyCreateOperationId(value: unknown): string {
  if (typeof value !== 'string' || !AGENT_SESSION_CREATE_OPERATION_ID_PATTERN.test(value)) {
    throw new Error('agent_session_operation_invalid')
  }
  return value
}

export function parsePtyCreateOperationInspection(value: unknown, expectedOperationId: string) {
  const operationId = parsePtyCreateOperationId(expectedOperationId)
  const record = value as Record<string, unknown> | null
  if (!record || record.version !== 1 || record.operationId !== operationId) {
    throw new Error('agent_session_operation_inspection_mismatch')
  }
  if (record.outcome === 'unverifiable') {
    return { version: 1 as const, operationId, outcome: 'unverifiable' as const }
  }
  if (
    record.outcome !== 'recorded' ||
    typeof record.terminalId !== 'string' ||
    !record.terminalId.trim() ||
    record.terminalId.length > 512 ||
    !isPtyIncarnationId(record.incarnationId)
  ) {
    throw new Error('agent_session_operation_inspection_invalid')
  }
  return {
    version: 1 as const,
    operationId,
    outcome: 'recorded' as const,
    terminalId: record.terminalId,
    incarnationId: record.incarnationId
  }
}
