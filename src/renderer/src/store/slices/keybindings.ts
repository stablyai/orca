import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  KeybindingActionId,
  KeybindingFileSnapshot,
  KeybindingOverrides
} from '../../../../shared/keybindings'

const EMPTY_KEYBINDINGS: KeybindingOverrides = {}

export type KeybindingsSlice = {
  keybindings: KeybindingOverrides
  keybindingSnapshot: KeybindingFileSnapshot | null
  fetchKeybindings: () => Promise<void>
  setKeybindingSnapshot: (snapshot: KeybindingFileSnapshot) => void
  ensureKeybindingsFile: () => Promise<KeybindingFileSnapshot | null>
  setKeybindingOverride: (actionId: KeybindingActionId, bindings: string[]) => Promise<void>
  resetKeybindingOverride: (actionId: KeybindingActionId) => Promise<void>
  disableKeybindingAction: (actionId: KeybindingActionId) => Promise<void>
  reloadKeybindings: () => Promise<void>
  openKeybindingsFile: () => Promise<void>
  revealKeybindingsFile: () => Promise<void>
}

function applySnapshot(
  snapshot: KeybindingFileSnapshot
): Pick<KeybindingsSlice, 'keybindings' | 'keybindingSnapshot'> {
  return {
    keybindings: snapshot.overrides,
    keybindingSnapshot: snapshot
  }
}

export const createKeybindingsSlice: StateCreator<AppState, [], [], KeybindingsSlice> = (set) => ({
  keybindings: EMPTY_KEYBINDINGS,
  keybindingSnapshot: null,

  setKeybindingSnapshot: (snapshot) => set(applySnapshot(snapshot)),

  ensureKeybindingsFile: async () => {
    if (!window.api.keybindings) {
      return null
    }
    try {
      const snapshot = await window.api.keybindings.ensureFile()
      set(applySnapshot(snapshot))
      return snapshot
    } catch (error) {
      console.error('Failed to prepare keybindings file:', error)
      throw error
    }
  },

  fetchKeybindings: async () => {
    if (!window.api.keybindings) {
      return
    }
    try {
      const snapshot = await window.api.keybindings.get()
      set(applySnapshot(snapshot))
    } catch (error) {
      console.error('Failed to fetch keybindings:', error)
    }
  },

  setKeybindingOverride: async (actionId, bindings) => {
    try {
      const snapshot = await window.api.keybindings.setAction({ actionId, bindings })
      set(applySnapshot(snapshot))
    } catch (error) {
      console.error('Failed to update keybinding:', error)
      throw error
    }
  },

  resetKeybindingOverride: async (actionId) => {
    try {
      const snapshot = await window.api.keybindings.setAction({ actionId, bindings: null })
      set(applySnapshot(snapshot))
    } catch (error) {
      console.error('Failed to reset keybinding:', error)
      throw error
    }
  },

  disableKeybindingAction: async (actionId) => {
    try {
      const snapshot = await window.api.keybindings.setAction({ actionId, bindings: [] })
      set(applySnapshot(snapshot))
    } catch (error) {
      console.error('Failed to disable keybinding:', error)
      throw error
    }
  },

  reloadKeybindings: async () => {
    if (!window.api.keybindings) {
      return
    }
    try {
      const snapshot = await window.api.keybindings.reload()
      set(applySnapshot(snapshot))
    } catch (error) {
      console.error('Failed to reload keybindings:', error)
    }
  },

  openKeybindingsFile: async () => {
    if (!window.api.keybindings) {
      return
    }
    try {
      const snapshot = await window.api.keybindings.openFile()
      set(applySnapshot(snapshot))
    } catch (error) {
      console.error('Failed to open keybindings file:', error)
    }
  },

  revealKeybindingsFile: async () => {
    if (!window.api.keybindings) {
      return
    }
    try {
      const snapshot = await window.api.keybindings.revealFile()
      set(applySnapshot(snapshot))
    } catch (error) {
      console.error('Failed to reveal keybindings file:', error)
    }
  }
})
