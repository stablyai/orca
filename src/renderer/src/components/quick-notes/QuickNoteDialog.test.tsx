// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, params?: Record<string, unknown>) =>
    params ? fallback.replace(/\{\{value0\}\}/g, String(params.value0)) : fallback
}))
vi.mock('@/lib/screen-submit-shortcut', () => ({
  isScreenSubmitShortcut: (e: { key: string; metaKey?: boolean; ctrlKey?: boolean }) =>
    e.key === 'Enter' && (Boolean(e.metaKey) || Boolean(e.ctrlKey)),
  getScreenSubmitShortcutLabel: () => '⌘ Enter'
}))

import { createQuickNoteDraft, QuickNoteDialog } from './QuickNoteDialog'

afterEach(cleanup)

describe('QuickNoteDialog', () => {
  it('disables Save until both label and body are non-empty', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <QuickNoteDialog
        open
        mode="add"
        note={createQuickNoteDraft()}
        onOpenChange={() => {}}
        onSave={onSave}
      />
    )
    const saveButton = screen.getByRole('button', { name: /save/i })
    expect(saveButton).toBeDisabled()

    await user.type(screen.getByLabelText('Label'), 'Signature')
    expect(saveButton).toBeDisabled()
    await user.type(screen.getByLabelText('Text'), 'Best,\nFrank')
    expect(saveButton).toBeEnabled()
  })

  it('emits a trimmed note on save', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <QuickNoteDialog
        open
        mode="edit"
        note={{ id: 'n1', label: '', body: '' }}
        onOpenChange={() => {}}
        onSave={onSave}
      />
    )
    await user.type(screen.getByLabelText('Label'), '  Signature  ')
    await user.type(screen.getByLabelText('Text'), 'line 1  ')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).toHaveBeenCalledWith({ id: 'n1', label: 'Signature', body: 'line 1' })
  })

  it('submits with the platform submit shortcut', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <QuickNoteDialog
        open
        mode="add"
        note={{ id: 'n2', label: 'L', body: 'B' }}
        onOpenChange={() => {}}
        onSave={onSave}
      />
    )
    await user.click(screen.getByLabelText('Text'))
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    expect(onSave).toHaveBeenCalledWith({ id: 'n2', label: 'L', body: 'B' })
  })
})
