import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { WslHostStatus } from '../../../../shared/wsl-host-types'
import { persistedUIValuesEqual } from '../../../../shared/persisted-ui-equality'

/** Each WSL host's connection status as main's liveness owner publishes it, by environment id. */
export type WslHostsSlice = {
  wslHostStatuses: Readonly<Record<string, WslHostStatus>>
  applyWslHostStatus: (status: WslHostStatus) => void
  /** Whether this build ships the server files WSL hosts deploy from; unknown until main answers. */
  wslHostServerFiles: 'unknown' | 'present' | 'missing'
  setWslHostServerFiles: (present: boolean) => void
  /** False in serve-only: no host is added and no project moved. False until main answers, so Add and Move never flash. */
  wslHostsAcceptNewWork: boolean
  setWslHostsAcceptNewWork: (accepts: boolean) => void
}

export const createWslHostsSlice: StateCreator<AppState, [], [], WslHostsSlice> = (set) => ({
  wslHostStatuses: {},
  wslHostServerFiles: 'unknown',
  setWslHostServerFiles: (present) => set({ wslHostServerFiles: present ? 'present' : 'missing' }),
  wslHostsAcceptNewWork: false,
  setWslHostsAcceptNewWork: (accepts) => set({ wslHostsAcceptNewWork: accepts }),
  applyWslHostStatus: (status) =>
    set((state) => {
      const current = state.wslHostStatuses[status.environmentId]
      if (persistedUIValuesEqual(current, status)) {
        return state
      }
      return { wslHostStatuses: { ...state.wslHostStatuses, [status.environmentId]: status } }
    })
})
