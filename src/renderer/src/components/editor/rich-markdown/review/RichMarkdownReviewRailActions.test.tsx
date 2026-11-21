// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import type { DiffComment } from '../../../../../../shared/file-review/diff-comment-types'

const mocks = vi.hoisted(() => ({
  skipClearMarkdownReviewNotesConfirm: false,
  updateSettings: vi.fn().mockResolvedValue(undefined),
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess
  }
}))

vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: {
        skipClearMarkdownReviewNotesConfirm: mocks.skipClearMarkdownReviewNotesConfirm
      },
      updateSettings: mocks.updateSettings,
      openSettingsPage: mocks.openSettingsPage,
      openSettingsTarget: mocks.openSettingsTarget
    })
}))

vi.mock('../../review-note-delivery/NotesSendMenu', () => ({
  NotesSendMenu: () => <div data-testid="notes-send-menu" />
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { RichMarkdownReviewRailActions } from './RichMarkdownReviewRailActions'

const OWNER: DiffCommentOwner = {
  kind: 'folder',
  worktreeId: 'wt-1',
  executionHostId: 'local',
  runtimeEnvironmentId: null
}

function makeNote(id: string, body: string, filePath = '/repo/docs/guide.md'): DiffComment {
  return {
    id,
    worktreeId: 'wt-1',
    filePath,
    lineNumber: 1,
    body,
    createdAt: 1,
    side: 'modified',
    source: 'markdown'
  }
}

function renderActions(
  overrides: Partial<React.ComponentProps<typeof RichMarkdownReviewRailActions>> = {}
) {
  const notes = overrides.notes ?? [makeNote('n1', 'first'), makeNote('n2', 'second')]
  const onClearNotes = overrides.onClearNotes ?? vi.fn().mockResolvedValue(true)
  const props: React.ComponentProps<typeof RichMarkdownReviewRailActions> = {
    owner: OWNER,
    worktreeId: 'wt-1',
    filePath: '/repo/docs/guide.md',
    noteCount: notes.length,
    notes,
    railOpen: true,
    notesCopied: false,
    unsentScope: [],
    onToggleRail: vi.fn(),
    onCopyNotes: vi.fn(),
    onClearNotes,
    onDelivered: vi.fn(),
    ...overrides
  }
  const result = render(<RichMarkdownReviewRailActions {...props} />, {
    wrapper: TooltipProvider
  })
  return { ...result, props, onClearNotes }
}

describe('RichMarkdownReviewRailActions', () => {
  beforeEach(() => {
    mocks.skipClearMarkdownReviewNotesConfirm = false
    mocks.updateSettings.mockReset().mockResolvedValue(undefined)
    mocks.openSettingsPage.mockReset()
    mocks.openSettingsTarget.mockReset()
    mocks.toastError.mockReset()
    mocks.toastSuccess.mockReset()
  })

  afterEach(cleanup)

  it('opens confirmation with file basename, focuses Cancel, and ignores Don’t ask again on cancel', async () => {
    const { onClearNotes } = renderActions()

    await userEvent.click(screen.getByRole('button', { name: 'Clear all notes' }))
    expect(await screen.findByText('Clear 2 notes from guide.md?')).toBeInTheDocument()
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus())

    await userEvent.click(screen.getByRole('checkbox', { name: "Don't ask again" }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() =>
      expect(screen.queryByText('Clear 2 notes from guide.md?')).not.toBeInTheDocument()
    )
    expect(onClearNotes).not.toHaveBeenCalled()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('clears the captured snapshot and persists Don’t ask again after confirmation succeeds', async () => {
    const initialNotes = [makeNote('n1', 'original'), makeNote('n2', 'second')]
    const { rerender, props, onClearNotes } = renderActions({ notes: initialNotes })

    await userEvent.click(screen.getByRole('button', { name: 'Clear all notes' }))
    await screen.findByText('Clear 2 notes from guide.md?')

    // Edit one note and add another while confirmation is open.
    const updatedNotes = [
      makeNote('n1', 'edited'),
      makeNote('n2', 'second'),
      makeNote('n3', 'added')
    ]
    rerender(
      <RichMarkdownReviewRailActions
        {...props}
        notes={updatedNotes}
        noteCount={updatedNotes.length}
      />
    )

    await userEvent.click(screen.getByRole('checkbox', { name: "Don't ask again" }))
    await userEvent.click(screen.getByRole('button', { name: 'Clear Notes' }))

    await waitFor(() => expect(onClearNotes).toHaveBeenCalledTimes(1))
    expect(onClearNotes).toHaveBeenCalledWith(OWNER, initialNotes)
    await waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith({
        skipClearMarkdownReviewNotesConfirm: true
      })
    )
    await waitFor(() =>
      expect(screen.queryByText('Clear 2 notes from guide.md?')).not.toBeInTheDocument()
    )
  })

  it('skips the confirmation dialog when skipClearMarkdownReviewNotesConfirm is enabled', async () => {
    mocks.skipClearMarkdownReviewNotesConfirm = true
    const initialNotes = [makeNote('n1', 'only')]
    const { onClearNotes } = renderActions({ notes: initialNotes })

    await userEvent.click(screen.getByRole('button', { name: 'Clear all notes' }))

    await waitFor(() => expect(onClearNotes).toHaveBeenCalledWith(OWNER, initialNotes))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('closes a stale confirmation dialog when filePath changes', async () => {
    const { rerender, props } = renderActions()

    await userEvent.click(screen.getByRole('button', { name: 'Clear all notes' }))
    await screen.findByText('Clear 2 notes from guide.md?')

    rerender(<RichMarkdownReviewRailActions {...props} filePath="/repo/docs/other.md" />)

    await waitFor(() =>
      expect(screen.queryByText('Clear 2 notes from guide.md?')).not.toBeInTheDocument()
    )
  })

  it('shows a single error toast and keeps the dialog open when clearing fails', async () => {
    const onClearNotes = vi.fn().mockResolvedValue(false)
    renderActions({ onClearNotes })

    await userEvent.click(screen.getByRole('button', { name: 'Clear all notes' }))
    await screen.findByText('Clear 2 notes from guide.md?')
    await userEvent.click(screen.getByRole('checkbox', { name: "Don't ask again" }))
    await userEvent.click(screen.getByRole('button', { name: 'Clear Notes' }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(screen.getByText('Clear 2 notes from guide.md?')).toBeInTheDocument()
  })

  it('disables the clear button when no owner is available', () => {
    renderActions({ owner: null })
    expect(screen.getByRole('button', { name: 'Clear all notes' })).toBeDisabled()
  })

  it('keeps the confirmation mounted for retry if persistence rejects after the last note is optimistically removed', async () => {
    const lastNote = [makeNote('n1', 'last')]
    let rejectFirstWrite: ((reason?: unknown) => void) | undefined
    const onClearNotes = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((_resolve, reject) => {
            rejectFirstWrite = reject
          })
      )
      .mockResolvedValueOnce(true)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender, props } = renderActions({ notes: lastNote, onClearNotes })

    await userEvent.click(screen.getByRole('button', { name: 'Clear all notes' }))
    await screen.findByText('Clear 1 note from guide.md?')
    await userEvent.click(screen.getByRole('checkbox', { name: "Don't ask again" }))
    await userEvent.click(screen.getByRole('button', { name: 'Clear Notes' }))

    // Optimistic store removal empties notes before persistence settles.
    rerender(<RichMarkdownReviewRailActions {...props} notes={[]} noteCount={0} />)
    expect(screen.queryByRole('button', { name: 'Clear all notes' })).not.toBeInTheDocument()
    expect(screen.getByText('Clear 1 note from guide.md?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear Notes' })).toBeDisabled()

    rejectFirstWrite?.(new Error('disk write failed'))
    rerender(<RichMarkdownReviewRailActions {...props} notes={lastNote} noteCount={1} />)

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(screen.getByText('Clear 1 note from guide.md?')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: "Don't ask again" })).toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: 'Clear Notes' }))
    await waitFor(() => expect(onClearNotes).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith({
        skipClearMarkdownReviewNotesConfirm: true
      })
    )
    await waitFor(() =>
      expect(screen.queryByText('Clear 1 note from guide.md?')).not.toBeInTheDocument()
    )
    consoleErrorSpy.mockRestore()
  })
})
