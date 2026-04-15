import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { SshConnectionState } from '../../../../shared/ssh-types'

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
  sshCredentialQueue: SshCredentialRequest[]
  setSshConnectionState: (targetId: string, state: SshConnectionState) => void
  setSshTargetLabels: (labels: Map<string, string>) => void
  enqueueSshCredentialRequest: (req: SshCredentialRequest) => void
  removeSshCredentialRequest: (requestId: string) => void
}

export const createSshSlice: StateCreator<AppState, [], [], SshSlice> = (set) => ({
  sshConnectionStates: new Map(),
  sshTargetLabels: new Map(),
  sshCredentialQueue: [],

  setSshConnectionState: (targetId, state) =>
    set((s) => {
      const next = new Map(s.sshConnectionStates)
      next.set(targetId, state)
      return { sshConnectionStates: next }
    }),

  setSshTargetLabels: (labels) => set({ sshTargetLabels: labels }),
  enqueueSshCredentialRequest: (req) =>
    set((s) => ({ sshCredentialQueue: [...s.sshCredentialQueue, req] })),
  removeSshCredentialRequest: (requestId) =>
    set((s) => ({
      sshCredentialQueue: s.sshCredentialQueue.filter((req) => req.requestId !== requestId)
    }))
})
