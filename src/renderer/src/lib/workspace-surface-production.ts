import type { ExecutionHostId } from '../../../shared/execution-host'
import { createBrowserUuid } from './browser-uuid'

export type WorkspaceSurfaceIdentity =
  | { kind: 'tab'; id: string }
  | { kind: 'workspace-content'; id: string }

export type WorkspaceSurfaceProductionResult =
  | { kind: 'materialized'; surface: WorkspaceSurfaceIdentity }
  | { kind: 'declined'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'unverifiable'; reason: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'unexpected'; reason: string }
  | { kind: 'intentional-empty' }

export type WorkspaceSurfaceProducerAttempt = {
  id: string
  workspaceKey: string
  executionHostId: ExecutionHostId
  purpose?: 'activation-recovery'
  result: Promise<WorkspaceSurfaceProductionResult>
}

export type WorkspaceSurfaceProducer = {
  attempt: WorkspaceSurfaceProducerAttempt
  materialized: (surface: WorkspaceSurfaceIdentity) => void
  declined: (reason: unknown) => void
  failed: (reason: unknown) => void
  unverifiable: (reason: unknown) => void
  blocked: (reason: unknown) => void
  unexpected: (reason: unknown) => void
  intentionalEmpty: () => void
}

export type WorkspaceSurfaceProducerEntry = {
  attempt: WorkspaceSurfaceProducerAttempt
  result: WorkspaceSurfaceProductionResult | null
  settle: (result: WorkspaceSurfaceProductionResult) => void
}

const entriesByAttemptId = new Map<string, WorkspaceSurfaceProducerEntry>()
const listeners = new Set<() => void>()

function notifyListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

function reasonText(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message
  }
  const text = String(reason)
  return text === '[object Object]' ? 'The surface producer did not provide a reason.' : text
}

export function registerWorkspaceSurfaceProducer(args: {
  workspaceKey: string
  executionHostId: ExecutionHostId
  attemptId?: string
  purpose?: 'activation-recovery'
}): WorkspaceSurfaceProducer {
  const id = args.attemptId?.trim() || createBrowserUuid()
  if (entriesByAttemptId.has(id)) {
    throw new Error(`A workspace surface producer already owns attempt ${id}.`)
  }
  let settlePromise: (result: WorkspaceSurfaceProductionResult) => void = () => undefined
  const result = new Promise<WorkspaceSurfaceProductionResult>((resolve) => {
    settlePromise = resolve
  })
  const attempt: WorkspaceSurfaceProducerAttempt = {
    id,
    workspaceKey: args.workspaceKey,
    executionHostId: args.executionHostId,
    ...(args.purpose ? { purpose: args.purpose } : {}),
    result
  }
  const entry: WorkspaceSurfaceProducerEntry = {
    attempt,
    result: null,
    settle: (settlement) => {
      if (entry.result && entry.result.kind !== 'unverifiable') {
        return
      }
      const firstSettlement = entry.result === null
      entry.result = settlement
      if (firstSettlement) {
        settlePromise(settlement)
      }
      notifyListeners()
    }
  }
  entriesByAttemptId.set(id, entry)
  notifyListeners()
  return {
    attempt,
    materialized: (surface) => entry.settle({ kind: 'materialized', surface }),
    declined: (reason) => entry.settle({ kind: 'declined', reason: reasonText(reason) }),
    failed: (reason) => entry.settle({ kind: 'failed', reason: reasonText(reason) }),
    unverifiable: (reason) => entry.settle({ kind: 'unverifiable', reason: reasonText(reason) }),
    blocked: (reason) => entry.settle({ kind: 'blocked', reason: reasonText(reason) }),
    unexpected: (reason) => entry.settle({ kind: 'unexpected', reason: reasonText(reason) }),
    intentionalEmpty: () => entry.settle({ kind: 'intentional-empty' })
  }
}

export function readWorkspaceSurfaceProducerEntries(args: {
  workspaceKey: string
  executionHostId: ExecutionHostId
}): readonly Readonly<WorkspaceSurfaceProducerEntry>[] {
  return [...entriesByAttemptId.values()].filter(
    (entry) =>
      entry.attempt.workspaceKey === args.workspaceKey &&
      entry.attempt.executionHostId === args.executionHostId
  )
}

export function consumeWorkspaceSurfaceProducerAttempt(attemptId: string): void {
  const entry = entriesByAttemptId.get(attemptId)
  if (!entry || entry.result === null || entry.result.kind === 'unverifiable') {
    return
  }
  entriesByAttemptId.delete(attemptId)
  notifyListeners()
}

export function discardWorkspaceSurfaceProducerAttempt(attemptId: string): void {
  if (entriesByAttemptId.delete(attemptId)) {
    notifyListeners()
  }
}

export function clearWorkspaceSurfaceProducerAttempts(args: {
  workspaceKey?: string
  executionHostId?: ExecutionHostId
}): string[] {
  const removed: string[] = []
  for (const [attemptId, entry] of entriesByAttemptId) {
    if (
      (args.workspaceKey === undefined || entry.attempt.workspaceKey === args.workspaceKey) &&
      (args.executionHostId === undefined || entry.attempt.executionHostId === args.executionHostId)
    ) {
      entriesByAttemptId.delete(attemptId)
      removed.push(attemptId)
    }
  }
  if (removed.length > 0) {
    notifyListeners()
  }
  return removed
}

export function subscribeWorkspaceSurfaceProducers(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetWorkspaceSurfaceProducersForTests(): void {
  clearWorkspaceSurfaceProducerAttempts({})
}
