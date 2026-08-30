import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type PaneCommandIdentityEntry = {
  ptyId: string
  commandEpoch: number
  startSeq: number
  agent: TuiAgent | null
  trusted: boolean
}

export type PaneCommandIdentitySlice = {
  paneCommandIdentityByPaneKey: Record<string, PaneCommandIdentityEntry>
  setPaneCommandIdentity: (paneKey: string, entry: PaneCommandIdentityEntry) => void
  clearPaneCommandIdentity: (paneKey: string, ptyId?: string) => void
}

export const createPaneCommandIdentitySlice: StateCreator<
  AppState,
  [],
  [],
  PaneCommandIdentitySlice
> = (set) => ({
  paneCommandIdentityByPaneKey: {},
  setPaneCommandIdentity: (paneKey, entry) =>
    set((state) => {
      const current = state.paneCommandIdentityByPaneKey[paneKey]
      if (current?.ptyId === entry.ptyId && current.commandEpoch >= entry.commandEpoch) {
        return state
      }
      return {
        paneCommandIdentityByPaneKey: {
          ...state.paneCommandIdentityByPaneKey,
          [paneKey]: entry
        }
      }
    }),
  clearPaneCommandIdentity: (paneKey, ptyId) =>
    set((state) => {
      const current = state.paneCommandIdentityByPaneKey[paneKey]
      if (!current || (ptyId !== undefined && current.ptyId !== ptyId)) {
        return state
      }
      const next = { ...state.paneCommandIdentityByPaneKey }
      delete next[paneKey]
      return { paneCommandIdentityByPaneKey: next }
    })
})
