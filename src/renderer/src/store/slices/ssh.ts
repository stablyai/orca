import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { SshConnectionState, SshConnectionStatus } from '../../../../shared/ssh-types'

export type SshSlice = {
  sshConnectionStates: Map<string, SshConnectionState>
  setSshConnectionState: (targetId: string, state: SshConnectionState) => void
  getSshConnectionStatus: (connectionId: string | null | undefined) => SshConnectionStatus | null
}

export const createSshSlice: StateCreator<AppState, [], [], SshSlice> = (set, get) => ({
  sshConnectionStates: new Map(),

  setSshConnectionState: (targetId, state) =>
    set(() => {
      const next = new Map(get().sshConnectionStates)
      next.set(targetId, state)
      return { sshConnectionStates: next }
    }),

  getSshConnectionStatus: (connectionId) => {
    if (!connectionId) {
      return null
    }
    const state = get().sshConnectionStates.get(connectionId)
    return state?.status ?? 'disconnected'
  }
})
