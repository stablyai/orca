import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type { QuickNote } from '../../../../shared/quick-note-types'
import { applyQuickNoteMutation, type QuickNoteMutation } from '../../../../shared/quick-notes'
import { translate } from '@/i18n/i18n'

export type QuickNotesSlice = {
  /** Last note the user copied; drives the split-button's primary action. */
  recentQuickNoteId: string | null
  setRecentQuickNoteId: (id: string) => void
  upsertQuickNote: (note: QuickNote) => Promise<boolean>
  deleteQuickNote: (id: string) => Promise<boolean>
}

async function mutateQuickNotes(
  get: Parameters<StateCreator<AppState>>[1],
  mutation: QuickNoteMutation
): Promise<boolean> {
  try {
    const current = get().settings?.quickNotes ?? []
    await get().updateSettingsOrThrow({ quickNotes: applyQuickNoteMutation(current, mutation) })
    return true
  } catch (error) {
    toast.error(
      translate('auto.store.slices.quick.notes.saveFailed', 'Failed to save quick note'),
      { description: error instanceof Error ? error.message : undefined }
    )
    return false
  }
}

export const createQuickNotesSlice: StateCreator<AppState, [], [], QuickNotesSlice> = (
  _set,
  get
) => ({
  recentQuickNoteId: null,
  setRecentQuickNoteId: (id) => _set({ recentQuickNoteId: id }),
  upsertQuickNote: (note) => mutateQuickNotes(get, { type: 'upsert', note }),
  deleteQuickNote: (id) => mutateQuickNotes(get, { type: 'delete', id })
})
