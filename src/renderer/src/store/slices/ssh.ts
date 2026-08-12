import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  SshConnectionState,
  PortForwardEntry,
  EnrichedDetectedPort,
  SshTarget
} from '../../../../shared/ssh-types'
import {
  buildRemovedSshTargetCleanupPatch,
  sshConnectionStatesEqual,
  sshTargetLabelsEqual
} from './ssh-target-cleanup'

export type RemoteWorkspaceSyncStatus = {
  phase: 'idle' | 'pulling' | 'pushing' | 'synced' | 'conflict' | 'error' | 'offline'
  direction?: 'pull' | 'push'
  revision?: number
  updatedAt?: number
  lastSyncedAt?: number
  message?: string
}

export type SshCredentialRequest = {
  requestId: string
  targetId: string
  kind: 'passphrase' | 'password'
  detail: string
}

export type SshSlice = {
  sshConnectionStates: Map<string, SshConnectionState>
  /** Maps target IDs to their user-facing labels. Populated during hydration
   * so components can look up labels without per-component IPC calls. */
  sshTargetLabels: Map<string, string>
  /** Maps REMOVED target IDs to their last known label (from re-adoption
   * tombstones). Lets ghost-host UI show a friendly name instead of the raw id
   * for a workspace still pinned to a deleted target. */
  removedSshTargetLabels: Map<string, string>
  /** True once a target list actually loaded (even an empty one). Distinguishes
   * "this client knows the target set" from "never hydrated" (e.g. a paired
   * client on a host without the ssh RPC), so absence from sshTargetLabels
   * only counts as removal evidence when this is set. */
  sshTargetsHydrated: boolean
  remoteWorkspaceHydratedTargetIds: Set<string>
  remoteWorkspaceSyncStatusByTargetId: Record<string, RemoteWorkspaceSyncStatus>
  sshCredentialQueue: SshCredentialRequest[]
  /** Incremented when an SSH target transitions to 'connected'. Allows
   * components like the file explorer to re-trigger data loads that failed
   * before the connection was established. */
  sshConnectedGeneration: number
  /** Port forwards keyed by connection ID. Updated via push events from main.
   *  Why Record instead of Map: Zustand selectors use shallow-equality on plain
   *  objects. Spreading a Record produces a new reference that Zustand can diff
   *  by identity, whereas Map mutations are easy to get wrong. */
  portForwardsByConnection: Record<string, PortForwardEntry[]>
  /** Detected remote listening ports after main-process enrichment, keyed by
   *  connection ID. Updated from SSH IPC snapshots and push events. */
  detectedPortsByConnection: Record<string, EnrichedDetectedPort[]>
  setSshConnectionState: (targetId: string, state: SshConnectionState) => void
  setSshTargetLabels: (labels: Map<string, string>) => void
  setRemovedSshTargetLabels: (labels: Record<string, string>) => void
  setSshTargetsMetadata: (targets: Pick<SshTarget, 'id' | 'label'>[]) => void
  clearRemovedSshTargetState: (targetId: string) => void
  markRemoteWorkspaceHydrated: (targetId: string) => void
  clearRemoteWorkspaceHydrated: (targetId: string) => void
  setRemoteWorkspaceSyncStatus: (targetId: string, status: RemoteWorkspaceSyncStatus) => void
  enqueueSshCredentialRequest: (req: SshCredentialRequest) => void
  removeSshCredentialRequest: (requestId: string) => void
  setPortForwards: (targetId: string, forwards: PortForwardEntry[]) => void
  clearPortForwards: (targetId: string) => void
  setDetectedPorts: (targetId: string, ports: EnrichedDetectedPort[]) => void
}

const targetConnectionGeneration = new Map<string, number>()

export function getLocalSshTargetConnectionGeneration(targetId: string): number {
  return targetConnectionGeneration.get(targetId) ?? 0
}

function advanceLocalSshTargetConnectionGeneration(targetId: string): void {
  targetConnectionGeneration.set(targetId, getLocalSshTargetConnectionGeneration(targetId) + 1)
}

export const createSshSlice: StateCreator<AppState, [], [], SshSlice> = (set) => ({
  sshConnectionStates: new Map(),
  sshTargetLabels: new Map(),
  removedSshTargetLabels: new Map(),
  sshTargetsHydrated: false,
  remoteWorkspaceHydratedTargetIds: new Set(),
  remoteWorkspaceSyncStatusByTargetId: {},
  sshCredentialQueue: [],
  sshConnectedGeneration: 0,
  portForwardsByConnection: {},
  detectedPortsByConnection: {},

  setSshConnectionState: (targetId, state) =>
    set((s) => {
      const next = new Map(s.sshConnectionStates)
      const previous = next.get(targetId)
      if (sshConnectionStatesEqual(previous, state)) {
        return s
      }
      advanceLocalSshTargetConnectionGeneration(targetId)
      next.set(targetId, state)
      const didReconnect = previous?.status !== 'connected' && state.status === 'connected'
      let blockedConnections = s.transientClearedAgentStatusConnectionIds
      if (didReconnect && targetId in blockedConnections) {
        blockedConnections = { ...blockedConnections }
        delete blockedConnections[targetId]
      }
      return {
        sshConnectionStates: next,
        sshConnectedGeneration: didReconnect
          ? s.sshConnectedGeneration + 1
          : s.sshConnectedGeneration,
        transientClearedAgentStatusConnectionIds: blockedConnections
      }
    }),

  setSshTargetLabels: (labels) => set({ sshTargetLabels: labels }),
  setRemovedSshTargetLabels: (labels) =>
    set({ removedSshTargetLabels: new Map(Object.entries(labels)) }),
  setSshTargetsMetadata: (targets) =>
    set((s) => {
      if (sshTargetLabelsEqual(s.sshTargetLabels, targets)) {
        // Why: an unchanged (even empty) list is still a successful load — the
        // hydration flag must flip on the first fetch of an empty target set.
        return s.sshTargetsHydrated ? s : { sshTargetsHydrated: true }
      }
      return {
        sshTargetLabels: new Map(targets.map((target) => [target.id, target.label])),
        sshTargetsHydrated: true
      }
    }),
  clearRemovedSshTargetState: (targetId) =>
    set((s) => buildRemovedSshTargetCleanupPatch(s, targetId) ?? s),
  markRemoteWorkspaceHydrated: (targetId) =>
    set((s) => {
      const next = new Set(s.remoteWorkspaceHydratedTargetIds)
      next.add(targetId)
      return { remoteWorkspaceHydratedTargetIds: next }
    }),
  clearRemoteWorkspaceHydrated: (targetId) =>
    set((s) => {
      const next = new Set(s.remoteWorkspaceHydratedTargetIds)
      next.delete(targetId)
      return { remoteWorkspaceHydratedTargetIds: next }
    }),
  setRemoteWorkspaceSyncStatus: (targetId, status) =>
    set((s) => ({
      remoteWorkspaceSyncStatusByTargetId: {
        ...s.remoteWorkspaceSyncStatusByTargetId,
        [targetId]: status
      }
    })),
  enqueueSshCredentialRequest: (req) =>
    set((s) => ({ sshCredentialQueue: [...s.sshCredentialQueue, req] })),
  removeSshCredentialRequest: (requestId) =>
    set((s) => ({
      sshCredentialQueue: s.sshCredentialQueue.filter((req) => req.requestId !== requestId)
    })),

  setPortForwards: (targetId, forwards) =>
    set((s) => {
      const next = { ...s.portForwardsByConnection }
      if (forwards.length > 0) {
        next[targetId] = forwards
      } else {
        delete next[targetId]
      }
      return { portForwardsByConnection: next }
    }),

  clearPortForwards: (targetId) =>
    set((s) => {
      const { [targetId]: _, ...rest } = s.portForwardsByConnection
      return { portForwardsByConnection: rest }
    }),

  setDetectedPorts: (targetId, ports) =>
    set((s) => {
      const next = { ...s.detectedPortsByConnection }
      if (ports.length > 0) {
        next[targetId] = ports
      } else {
        delete next[targetId]
      }
      return { detectedPortsByConnection: next }
    })
})
