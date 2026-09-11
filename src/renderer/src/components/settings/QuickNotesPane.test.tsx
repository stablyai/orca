// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { QuickNote } from '../../../../shared/quick-note-types'

const upsertQuickNote = vi.fn().mockResolvedValue(true)
const deleteQuickNote = vi.fn().mockResolvedValue(true)
const recordFeatureInteraction = vi.fn()
const confirm = vi.fn().mockResolvedValue(true)

vi.mock('@/i18n/i18n', () => ({
  translate: (_k: string, fallback: string, p?: Record<string, unknown>) =>
    p ? fallback.replace(/\{\{value0\}\}/g, String(p.value0)) : fallback
}))
vi.mock('@/lib/screen-submit-shortcut', () => ({
  isScreenSubmitShortcut: () => false,
  getScreenSubmitShortcutLabel: () => '⌘ Enter'
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirm
}))
vi.mock('../../store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({ upsertQuickNote, deleteQuickNote, recordFeatureInteraction })
  })
}))

import { QuickNotesPane } from './QuickNotesPane'

const notes: QuickNote[] = [
  { id: 'a', label: 'Email signature', body: 'Best' },
  { id: 'b', label: 'Deploy block', body: 'kubectl' }
]

const renderPane = (quickNotes = notes) =>
  render(<QuickNotesPane settings={{ ...getDefaultSettings('/tmp'), quickNotes }} />)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('QuickNotesPane', () => {
  it('filters the list with the search field', async () => {
    const user = userEvent.setup()
    renderPane()
    await user.type(screen.getByLabelText('Search notes'), 'deploy')
    expect(screen.queryByText('Email signature')).not.toBeInTheDocument()
    expect(screen.getByText('Deploy block')).toBeInTheDocument()
  })

  it('saves a new note through the store and records the interaction', async () => {
    const user = userEvent.setup()
    renderPane([])
    await user.click(screen.getByRole('button', { name: 'Add Note' }))
    await user.type(screen.getByLabelText('Label'), 'Greeting')
    await user.type(screen.getByLabelText('Text'), 'Hello there')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(upsertQuickNote).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Greeting', body: 'Hello there' })
    )
    expect(recordFeatureInteraction).toHaveBeenCalledWith('quick-notes')
  })

  it('confirms then deletes a note', async () => {
    const user = userEvent.setup()
    renderPane()
    await user.click(screen.getByRole('button', { name: 'Remove Email signature' }))
    expect(confirm).toHaveBeenCalledOnce()
    expect(deleteQuickNote).toHaveBeenCalledWith('a')
  })
})
