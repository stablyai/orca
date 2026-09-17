import type { ExecutionHostId } from './execution-host'
import type { AgentStatusRunVerdict } from './agent-status-run'
import type {
  AgentExecutionAttachment,
  AgentExecutionHostInventory,
  AgentExecutionObservation
} from './agent-execution-observation'

export type ObservationHostScan = { controller: AbortController; promise: Promise<void> }
type VersionedAttachment = AgentExecutionAttachment & { generation: number }

export function resolveHostInventory(
  hostId: ExecutionHostId,
  requested: readonly VersionedAttachment[],
  inventory: AgentExecutionHostInventory,
  attachments: ReadonlyMap<string, VersionedAttachment>,
  captureRevisionByHost: Map<ExecutionHostId, number>,
  publish: (attachment: VersionedAttachment, observation: AgentExecutionObservation) => void
): void {
  const revision = (captureRevisionByHost.get(hostId) ?? 0) + 1
  captureRevisionByHost.set(hostId, revision)
  for (const requestedAttachment of requested) {
    const current = attachments.get(requestedAttachment.executionId)
    if (!current || current.generation !== requestedAttachment.generation) {
      continue
    }
    publish(current, {
      executionId: current.executionId,
      ...(current.runId !== undefined ? { runId: current.runId } : {}),
      ...(current.role !== undefined ? { role: current.role } : {}),
      ...(current.continuityOf !== undefined ? { continuityOf: current.continuityOf } : {}),
      hostId,
      hostEpoch: inventory.hostEpoch,
      captureRevision: revision,
      observedAt: inventory.capturedAt,
      inventoryCoverage: inventory.inventoryCoverage,
      verdict: resolveExecutionVerdict(current, inventory)
    })
  }
}

export function resolveHostFailure(
  hostId: ExecutionHostId,
  requested: readonly VersionedAttachment[],
  attachments: ReadonlyMap<string, VersionedAttachment>,
  captureRevisionByHost: Map<ExecutionHostId, number>,
  now: () => number,
  publish: (attachment: VersionedAttachment, observation: AgentExecutionObservation) => void
): void {
  const revision = (captureRevisionByHost.get(hostId) ?? 0) + 1
  captureRevisionByHost.set(hostId, revision)
  for (const requestedAttachment of requested) {
    const current = attachments.get(requestedAttachment.executionId)
    if (!current || current.generation !== requestedAttachment.generation) {
      continue
    }
    publish(current, {
      executionId: current.executionId,
      ...(current.runId !== undefined ? { runId: current.runId } : {}),
      ...(current.role !== undefined ? { role: current.role } : {}),
      ...(current.continuityOf !== undefined ? { continuityOf: current.continuityOf } : {}),
      hostId,
      hostEpoch: current.hostEpoch,
      captureRevision: revision,
      observedAt: now(),
      inventoryCoverage: 'partial',
      verdict: 'unverifiable'
    })
  }
}

export function resolveExecutionVerdict(
  attachment: AgentExecutionAttachment,
  inventory: AgentExecutionHostInventory
): AgentStatusRunVerdict {
  if (inventory.inventoryCoverage !== 'complete') {
    return 'unverifiable'
  }
  const observed = inventory.verdictByProcessIncarnation?.get(attachment.processIncarnation ?? '')
  if (observed) {
    return observed
  }
  if (attachment.processIncarnation) {
    return inventory.processIncarnations.has(attachment.processIncarnation) ? 'live' : 'exited'
  }
  if (attachment.providerInvocation) {
    return inventory.providerInvocations?.has(attachment.providerInvocation) ? 'live' : 'exited'
  }
  return 'unverifiable'
}

export function buildUnverifiableExecutionObservation(
  captureRevisionByHost: Map<ExecutionHostId, number>,
  now: () => number,
  executionId: string,
  attachment: AgentExecutionAttachment | undefined
): AgentExecutionObservation {
  const hostId = attachment?.hostId ?? 'local'
  const revision = (captureRevisionByHost.get(hostId) ?? 0) + 1
  captureRevisionByHost.set(hostId, revision)
  return {
    executionId,
    ...(attachment?.runId !== undefined ? { runId: attachment.runId } : {}),
    ...(attachment?.role !== undefined ? { role: attachment.role } : {}),
    ...(attachment?.continuityOf !== undefined ? { continuityOf: attachment.continuityOf } : {}),
    hostId,
    hostEpoch: attachment?.hostEpoch ?? 'unknown',
    captureRevision: revision,
    observedAt: now(),
    inventoryCoverage: 'partial',
    verdict: 'unverifiable'
  }
}

export function hasCurrentHostAttachment(
  attachments: ReadonlyMap<string, AgentExecutionAttachment>,
  hostId: ExecutionHostId
): boolean {
  return [...attachments.values()].some((attachment) => attachment.hostId === hostId)
}

export function cancelObsoleteHostScan(
  pending: ReadonlyMap<string, unknown>,
  attachments: ReadonlyMap<string, AgentExecutionAttachment>,
  scans: ReadonlyMap<ExecutionHostId, ObservationHostScan>,
  hostId: ExecutionHostId
): void {
  const hasPending = [...pending.keys()].some(
    (executionId) => attachments.get(executionId)?.hostId === hostId
  )
  if (!hasPending) {
    scans.get(hostId)?.controller.abort()
  }
}
