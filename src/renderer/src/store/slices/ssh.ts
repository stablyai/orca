import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  SshConnectionState,
  PortForwardEntry,
  DetectedPort,
  SshTarget
} from '../../../../shared/ssh-types'

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
  sshTargetRemoteSyncEnabled: Map<string, boolean>
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
  /** Detected listening ports on the remote, keyed by connection ID.
   *  Updated by polling the relay's ports.detect RPC. */
  detectedPortsByConnection: Record<string, DetectedPort[]>
  setSshConnectionState: (targetId: string, state: SshConnectionState) => void
  setSshTargetLabels: (labels: Map<string, string>) => void
  setSshTargetsMetadata: (
    targets: Pick<SshTarget, 'id' | 'label' | 'remoteWorkspaceSyncEnabled'>[]
  ) => void
  markRemoteWorkspaceHydrated: (targetId: string) => void
  clearRemoteWorkspaceHydrated: (targetId: string) => void
  setRemoteWorkspaceSyncStatus: (targetId: string, status: RemoteWorkspaceSyncStatus) => void
  enqueueSshCredentialRequest: (req: SshCredentialRequest) => void
  removeSshCredentialRequest: (requestId: string) => void
  bumpSshConnectedGeneration: () => void
  setPortForwards: (targetId: string, forwards: PortForwardEntry[]) => void
  clearPortForwards: (targetId: string) => void
  setDetectedPorts: (targetId: string, ports: DetectedPort[]) => void
}

export const createSshSlice: StateCreator<AppState, [], [], SshSlice> = (set) => ({
  sshConnectionStates: new Map(),
  sshTargetLabels: new Map(),
  sshTargetRemoteSyncEnabled: new Map(),
  remoteWorkspaceHydratedTargetIds: new Set(),
  remoteWorkspaceSyncStatusByTargetId: {},
  sshCredentialQueue: [],
  sshConnectedGeneration: 0,
  portForwardsByConnection: {},
  detectedPortsByConnection: {},

  setSshConnectionState: (targetId, state) =>
    set((s) => {
      const next = new Map(s.sshConnectionStates)
      next.set(targetId, state)
      return { sshConnectionStates: next }
    }),

  setSshTargetLabels: (labels) => set({ sshTargetLabels: labels }),
  setSshTargetsMetadata: (targets) =>
    set({
      sshTargetLabels: new Map(targets.map((target) => [target.id, target.label])),
      sshTargetRemoteSyncEnabled: new Map(
        targets.map((target) => [target.id, target.remoteWorkspaceSyncEnabled === true])
      )
    }),
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
  bumpSshConnectedGeneration: () =>
    set((s) => ({ sshConnectedGeneration: s.sshConnectedGeneration + 1 })),

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
