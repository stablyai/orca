import { create } from 'zustand'
import {
  closeDialogEntry,
  dialogContentMounted,
  dialogContentUnmounted,
  endDialogEntry,
  enqueueAutomaticDialog,
  INITIAL_DIALOG_REGISTRY,
  openDialogEntry,
  settleStartupSource,
  type DialogRegistry
} from './dialog-registry-state'

type DialogRegistryActions = {
  openDialog: (...args: DropFirst<Parameters<typeof openDialogEntry>>) => void
  enqueueAutomaticDialog: (...args: DropFirst<Parameters<typeof enqueueAutomaticDialog>>) => void
  closeDialog: (token: string) => void
  endDialog: (token: string) => void
  dialogContentMounted: (...args: DropFirst<Parameters<typeof dialogContentMounted>>) => void
  dialogContentUnmounted: (token: string) => void
  settleStartupSource: (...args: DropFirst<Parameters<typeof settleStartupSource>>) => void
}

type DropFirst<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never

export type DialogRegistryStore = DialogRegistry & DialogRegistryActions

// Window-scoped presentation state stays separate from persisted app data.
export const useDialogRegistry = create<DialogRegistryStore>()((set) => ({
  ...INITIAL_DIALOG_REGISTRY,
  openDialog: (...args) => set((s) => openDialogEntry(s, ...args)),
  enqueueAutomaticDialog: (...args) => set((s) => enqueueAutomaticDialog(s, ...args)),
  closeDialog: (token) => set((s) => closeDialogEntry(s, token)),
  endDialog: (token) => set((s) => endDialogEntry(s, token)),
  dialogContentMounted: (...args) => set((s) => dialogContentMounted(s, ...args)),
  dialogContentUnmounted: (token) => set((s) => dialogContentUnmounted(s, token)),
  settleStartupSource: (...args) => set((s) => settleStartupSource(s, ...args))
}))
