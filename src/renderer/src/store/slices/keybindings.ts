import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { KeybindingSnapshot } from '../../../../shared/keybindings/keybinding-types'

export type KeybindingsSlice = {
  keybindingSnapshot: KeybindingSnapshot | null
  fetchKeybindings: () => Promise<void>
  reloadKeybindings: () => Promise<void>
  setKeybindingSnapshot: (snapshot: KeybindingSnapshot) => void
}

export const createKeybindingsSlice: StateCreator<AppState, [], [], KeybindingsSlice> = (set) => ({
  keybindingSnapshot: null,

  fetchKeybindings: async () => {
    try {
      const snapshot = await window.api.keybindings.getSnapshot()
      set({ keybindingSnapshot: snapshot })
    } catch (err) {
      console.error('Failed to fetch keybindings:', err)
    }
  },

  reloadKeybindings: async () => {
    try {
      const snapshot = await window.api.keybindings.reload()
      set({ keybindingSnapshot: snapshot })
    } catch (err) {
      console.error('Failed to reload keybindings:', err)
    }
  },

  setKeybindingSnapshot: (snapshot) => set({ keybindingSnapshot: snapshot })
})
