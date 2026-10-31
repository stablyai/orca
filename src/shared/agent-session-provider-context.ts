import type { AgentSessionRecord } from './agent-session-record'

export type AgentSessionProviderContextBoundary = {
  operationId: string
  afterFence: number
  clearedAt: number
  /** Durable background context for the first ordinary send after a handoff. */
  handoff?: string
}

export function isAgentSessionProviderContextBoundary(
  value: unknown
): value is AgentSessionProviderContextBoundary {
  return (
    typeof value === 'object' &&
    value !== null &&
    'operationId' in value &&
    typeof value.operationId === 'string' &&
    value.operationId.length > 0 &&
    value.operationId.length <= 512 &&
    'afterFence' in value &&
    typeof value.afterFence === 'number' &&
    Number.isSafeInteger(value.afterFence) &&
    value.afterFence >= 0 &&
    'clearedAt' in value &&
    typeof value.clearedAt === 'number' &&
    Number.isSafeInteger(value.clearedAt) &&
    value.clearedAt >= 0 &&
    (!('handoff' in value) ||
      (typeof value.handoff === 'string' &&
        value.handoff.length > 0 &&
        value.handoff.length <= 65536))
  )
}

/** Clear resets the chain; the boundary identifies a fresh launch before its first proof. */
export function activeProviderContext(
  record: Pick<AgentSessionRecord, 'providerHandleChain' | 'providerContextBoundary'>
) {
  const handleChain = record.providerHandleChain
  const head = handleChain.at(-1) ?? null
  return {
    handleChain,
    head,
    pendingClear: record.providerContextBoundary !== undefined && head === null
  }
}
