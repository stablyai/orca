import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { SshConnectionState, SshConnectionStatus } from '../../../../shared/ssh-types'

export type SshSlice = {
  sshConnectionStates: Map<string, SshConnectionState>
  /** Maps target IDs to their user-facing labels. Populated during hydration
   * so components can look up labels without per-component IPC calls. */
  sshTargetLabels: Map<string, string>
  setSshConnectionState: (targetId: string, state: SshConnectionState) => void
  setSshTargetLabels: (labels: Map<string, string>) => void
  getSshConnectionStatus: (connectionId: string | null | undefined) => SshConnectionStatus | null
}

export const createSshSlice: StateCreator<AppState, [], [], SshSlice> = (set, get) => ({
  sshConnectionStates: new Map(),
  sshTargetLabels: new Map(),

  setSshConnectionState: (targetId, state) =>
    set(() => {
      const next = new Map(get().sshConnectionStates)
      next.set(targetId, state)
      return { sshConnectionStates: next }
    }),

  setSshTargetLabels: (labels) => set({ sshTargetLabels: labels }),

  getSshConnectionStatus: (connectionId) => {
    if (!connectionId) {
      return null
    }
    const state = get().sshConnectionStates.get(connectionId)
    return state?.status ?? 'disconnected'
  }
})
