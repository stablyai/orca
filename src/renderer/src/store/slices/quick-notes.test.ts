import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { getDefaultSettings } from '../../../../shared/constants'
import type { QuickNote } from '../../../../shared/quick-note-types'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const noteA: QuickNote = { id: 'a', label: 'A', body: 'body a' }
const noteB: QuickNote = { id: 'b', label: 'B', body: 'body b' }

function storeWithNotes(
  notes: QuickNote[],
  updateSettingsOrThrow = vi.fn().mockResolvedValue(undefined)
) {
  const store = createTestStore()
  store.setState({
    settings: { ...getDefaultSettings('/tmp'), quickNotes: notes },
    updateSettingsOrThrow
  })
  return { store, updateSettingsOrThrow }
}

beforeEach(() => vi.clearAllMocks())

describe('quick notes slice', () => {
  it('upsert appends a new note through updateSettingsOrThrow', async () => {
    const { store, updateSettingsOrThrow } = storeWithNotes([noteA])
    await store.getState().upsertQuickNote(noteB)
    expect(updateSettingsOrThrow).toHaveBeenCalledWith({ quickNotes: [noteA, noteB] })
  })

  it('upsert replaces an existing note by id', async () => {
    const { store, updateSettingsOrThrow } = storeWithNotes([noteA, noteB])
    const renamed = { ...noteA, label: 'A2' }
    await store.getState().upsertQuickNote(renamed)
    expect(updateSettingsOrThrow).toHaveBeenCalledWith({ quickNotes: [renamed, noteB] })
  })

  it('delete removes a note by id', async () => {
    const { store, updateSettingsOrThrow } = storeWithNotes([noteA, noteB])
    await store.getState().deleteQuickNote('a')
    expect(updateSettingsOrThrow).toHaveBeenCalledWith({ quickNotes: [noteB] })
  })

  it('returns false and does not throw when persistence rejects', async () => {
    const { store } = storeWithNotes([], vi.fn().mockRejectedValue(new Error('disk full')))
    await expect(store.getState().upsertQuickNote(noteA)).resolves.toBe(false)
  })

  it('setRecentQuickNoteId updates state', () => {
    const { store } = storeWithNotes([noteA])
    store.getState().setRecentQuickNoteId('a')
    expect(store.getState().recentQuickNoteId).toBe('a')
  })
})
