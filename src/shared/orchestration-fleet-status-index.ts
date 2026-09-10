import {
  fleetWorkerIdentity,
  type FleetAgentStatusEvidence,
  type FleetEvidenceBinding,
  type FleetWorkerIdentity
} from './orchestration-fleet-agent-status-evidence'
import type { FleetDurableWorker } from './orchestration-fleet-projection'
import { readWorkerTerminalHostScope } from './worker-terminal-host-scope'

export type FleetStatusIndex = {
  byDispatchId: Map<string, FleetAgentStatusEvidence>
  byPaneKey: Map<string, FleetAgentStatusEvidence>
  byTerminalHandle: Map<string, FleetAgentStatusEvidence>
  paneOwners: Map<string, Set<string>>
  handleOwners: Map<string, Set<string>>
}

export function createFleetStatusIndex(
  statuses: readonly FleetAgentStatusEvidence[],
  workers: readonly FleetDurableWorker[]
): FleetStatusIndex {
  const index: FleetStatusIndex = {
    byDispatchId: new Map(),
    byPaneKey: new Map(),
    byTerminalHandle: new Map(),
    paneOwners: new Map(),
    handleOwners: new Map()
  }
  const paneKeys = new Set<string>()
  const dispatchIds = new Set<string>()
  const terminalHandles = new Set<string>()
  for (const worker of workers) {
    dispatchIds.add(worker.dispatchId)
    const identity = fleetWorkerIdentity(worker)
    if (identity.kind === 'unidentifiable') {
      continue
    }
    if (identity.kind === 'pane_and_terminal') {
      paneKeys.add(identity.paneKey)
      addOwner(index.paneOwners, identity.paneKey, worker.dispatchId)
    }
    terminalHandles.add(identity.terminalHandle)
    addOwner(index.handleOwners, identity.terminalHandle, worker.dispatchId)
  }
  for (const evidence of statuses) {
    const binding = evidence.binding
    // An unresolved row identifies nothing; indexing it under the pane it was observed on is
    // exactly the false bind this union exists to prevent.
    if (binding.kind === 'unresolved') {
      continue
    }
    if (binding.kind === 'worker' && dispatchIds.has(binding.dispatchId)) {
      keepFreshest(index.byDispatchId, binding.dispatchId, evidence)
    }
    if (paneKeys.has(binding.paneKey)) {
      keepFreshest(index.byPaneKey, binding.paneKey, evidence)
    }
    if (terminalHandles.has(binding.terminalHandle)) {
      keepFreshest(index.byTerminalHandle, binding.terminalHandle, evidence)
    }
  }
  return index
}

function addOwner(ownersByKey: Map<string, Set<string>>, key: string, dispatchId: string): void {
  const owners = ownersByKey.get(key) ?? new Set<string>()
  owners.add(dispatchId)
  ownersByKey.set(key, owners)
}

/** Delivery order, deliberately: replays restamp `deliveredAt`, and the newest delivery is the
 *  row the pane's producer last asserted. The observation clock decides staleness, never order. */
function keepFreshest(
  statusesByKey: Map<string, FleetAgentStatusEvidence>,
  key: string,
  evidence: FleetAgentStatusEvidence
): void {
  const current = statusesByKey.get(key)
  if (!current || current.deliveredAt < evidence.deliveredAt) {
    statusesByKey.set(key, evidence)
  }
}

export function statusForFleetWorker(
  worker: FleetDurableWorker,
  index: FleetStatusIndex
): FleetAgentStatusEvidence | undefined {
  const identity = fleetWorkerIdentity(worker)
  if (identity.kind === 'unidentifiable') {
    return undefined
  }
  const byDispatch = index.byDispatchId.get(worker.dispatchId)
  if (byDispatch && statusIdentityMatchesWorker(worker, identity, byDispatch, index)) {
    return byDispatch
  }
  const candidates = [
    identity.kind === 'pane_and_terminal' ? index.byPaneKey.get(identity.paneKey) : undefined,
    index.byTerminalHandle.get(identity.terminalHandle)
  ].filter((evidence): evidence is FleetAgentStatusEvidence =>
    Boolean(evidence && statusIdentityMatchesWorker(worker, identity, evidence, index))
  )
  return candidates.sort((left, right) => right.deliveredAt - left.deliveredAt)[0]
}

function statusIdentityMatchesWorker(
  worker: FleetDurableWorker,
  identity: FleetWorkerIdentity,
  evidence: FleetAgentStatusEvidence,
  index: FleetStatusIndex
): boolean {
  const binding = evidence.binding
  if (binding.kind === 'unresolved' || identity.kind === 'unidentifiable') {
    return false
  }
  if (binding.kind === 'worker' && binding.dispatchId !== worker.dispatchId) {
    return false
  }
  if (binding.terminalHandle !== identity.terminalHandle) {
    return false
  }
  const remoteTargetId = remoteTargetForWorker(worker)
  if (remoteTargetId && evidence.activity.connectionId !== remoteTargetId) {
    return false
  }
  if (!incarnationMatchesWorker(worker, binding)) {
    return false
  }
  const paneMatches = identity.kind !== 'pane_and_terminal' || binding.paneKey === identity.paneKey
  if (binding.kind === 'worker') {
    // A row that names this dispatch on this handle may be a reminted pane; the durable
    // resource's incarnation is what makes the handle authoritative across the remint.
    return paneMatches || Boolean(worker.resource?.processIncarnation)
  }
  return (
    paneMatches &&
    uniqueOwner(
      index.paneOwners,
      identity.kind === 'pane_and_terminal' ? identity.paneKey : null
    ) &&
    uniqueOwner(index.handleOwners, identity.terminalHandle)
  )
}

/** The durable resource names the incarnation the worker was dispatched onto. A hook row carries
 *  no incarnation of its own, so the pane's incarnation at mint time is what says which process
 *  the evidence describes; a row minted against a different one is evidence about that process.
 *  A worker with no materialized resource has no incarnation authority to contradict, and
 *  fencing it out on absence would report a running unsupervised worker as missing. */
function incarnationMatchesWorker(
  worker: FleetDurableWorker,
  binding: Exclude<FleetEvidenceBinding, { kind: 'unresolved' }>
): boolean {
  const durable = worker.resource?.processIncarnation
  return !durable || durable === binding.processIncarnation
}

function uniqueOwner(ownersByKey: Map<string, Set<string>>, key: string | null): boolean {
  return key ? ownersByKey.get(key)?.size === 1 : true
}

/** Only a remote scope that names a target fences the connection the evidence must ride. */
function remoteTargetForWorker(worker: FleetDurableWorker): string | null {
  const read = readWorkerTerminalHostScope(worker.resource?.hostScope)
  return read.kind === 'remote' ? read.targetId : null
}
