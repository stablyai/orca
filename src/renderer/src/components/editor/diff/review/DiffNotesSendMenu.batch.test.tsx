// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import {
  diffCommentSendKey,
  holdNotesForSend,
  resetNotesInFlightForTests
} from '@/components/notes/delivery/notes-send-in-flight'
import type { DiffComment } from '../../../../../../shared/diff-comment-types'
import { SELF_LOCAL_AUTHORITY } from '../../../../../../shared/host-authority'
import { notesSendTestStore } from '../../review-note-delivery/notes-send-menu-store.test-fixture'
import { DiffNotesSendMenu } from './DiffNotesSendMenu'

vi.mock('@/store', async () => ({
  useAppStore: (await import('../../review-note-delivery/notes-send-menu-store.test-fixture'))
    .notesSendTestStore
}))
vi.mock('@/store/index', async () => ({
  useAppStore: (await import('../../review-note-delivery/notes-send-menu-store.test-fixture'))
    .notesSendTestStore
}))
vi.mock('@/store/retained-views/app-state-view', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAppStateValue: (await import('../../review-note-delivery/notes-send-menu-store.test-fixture'))
    .useNotesSendTestStateValue
}))
// Agent targets are outside this menu's job; it only decides which notes a send carries.
vi.mock('../../review-note-delivery/ReviewNotesSendMenuContent', () => ({
  ReviewNotesSendMenuContent: () => null
}))

const WT = 'repo::/wt'
const OWNER: DiffCommentOwner = {
  kind: 'worktree',
  worktreeId: WT,
  authority: SELF_LOCAL_AUTHORITY
}

function note(id: string, filePath: string, body: string, sentAt?: number): DiffComment {
  return {
    id,
    worktreeId: WT,
    filePath,
    lineNumber: 3,
    body,
    createdAt: 1,
    side: 'modified',
    sentAt
  }
}

const A = note('a1', 'src/a.ts', 'Rename this in A')
const B = note('b1', 'src/b.ts', 'Null check in B')

function renderFileMenu(comments: DiffComment[], filePath = 'src/a.ts'): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <DiffNotesSendMenu
        owner={OWNER}
        worktreeId={WT}
        groupId={WT}
        comments={comments}
        filePath={filePath}
        showFileScope
        batch={{ size: 'sm' }}
      />
    </TooltipProvider>
  )
}

function openMenu(button: HTMLElement): void {
  fireEvent.pointerDown(button, { button: 0, ctrlKey: false, pointerType: 'mouse' })
}

beforeEach(() => {
  notesSendTestStore.setState({ agentSendPopoverTargetMode: null })
  Object.assign(window, { api: { ui: { writeClipboardText: vi.fn() } } })
})

afterEach(() => {
  cleanup()
  resetNotesInFlightForTests()
  vi.restoreAllMocks()
})

describe('DiffNotesSendMenu batch button', () => {
  it('shows nothing when this file has nothing left to send', () => {
    renderFileMenu([B, note('a2', 'src/a.ts', 'Already sent', 1)])

    expect(screen.queryByRole('button')).toBeNull()
  })

  it("counts this file's notes and opens a send of only those", () => {
    renderFileMenu([A, B])

    openMenu(screen.getByRole('button', { name: 'Send 1 note to an agent' }))

    const prompt = notesSendTestStore.getState().agentSendPopoverTargetMode?.prompt ?? ''
    expect(prompt).toContain('Rename this in A')
    expect(prompt).not.toContain('Null check in B')
  })

  it('drops the opened send when its last note goes away', () => {
    const view = renderFileMenu([A, B])
    openMenu(screen.getByRole('button', { name: 'Send 1 note to an agent' }))
    expect(notesSendTestStore.getState().agentSendPopoverTargetMode).not.toBeNull()

    view.rerender(
      <TooltipProvider>
        <DiffNotesSendMenu
          owner={OWNER}
          worktreeId={WT}
          groupId={WT}
          comments={[B]}
          filePath="src/a.ts"
          showFileScope
          batch={{ size: 'sm' }}
        />
      </TooltipProvider>
    )

    expect(notesSendTestStore.getState().agentSendPopoverTargetMode).toBeNull()
  })

  it("shows Sending… while this file's notes are held, without sending the other files", () => {
    holdNotesForSend([diffCommentSendKey(OWNER, A)], new Promise(() => undefined))
    renderFileMenu([A, B])

    const button = screen.getByRole('button', { name: 'Sending…' })
    expect(button).toBeDisabled()
    openMenu(button)
    expect(notesSendTestStore.getState().agentSendPopoverTargetMode).toBeNull()
  })

  it('comes back with the notes when the send fails', async () => {
    let fail: (reason: Error) => void = () => undefined
    holdNotesForSend(
      [diffCommentSendKey(OWNER, A)],
      new Promise((_, reject) => {
        fail = reject
      })
    )
    renderFileMenu([A])
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()

    await act(async () => fail(new Error('agent exited')))

    expect(screen.getByRole('button', { name: 'Send 1 note to an agent' })).toBeEnabled()
  })

  it("copies this file's notes from the menu", async () => {
    renderFileMenu([A, B])
    openMenu(screen.getByRole('button', { name: 'Send 1 note to an agent' }))

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy notes' }))

    const copied = vi.mocked(window.api.ui.writeClipboardText).mock.calls[0]?.[0] ?? ''
    expect(copied).toContain('Rename this in A')
    expect(copied).not.toContain('Null check in B')
  })

  it('clears only the notes the confirmation counted', async () => {
    const deleteByIds = vi.fn(async () => true)
    notesSendTestStore.setState({ deleteDiffCommentsByIds: deleteByIds })
    const view = renderFileMenu([A, B])
    openMenu(screen.getByRole('button', { name: 'Send 1 note to an agent' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Clear notes…' }))
    expect(await screen.findByText('Clear 1 note from src/a.ts?')).toBeVisible()

    // A note added while the dialog is open is not part of what it asked about.
    view.rerender(
      <TooltipProvider>
        <DiffNotesSendMenu
          owner={OWNER}
          worktreeId={WT}
          groupId={WT}
          comments={[A, B, note('a3', 'src/a.ts', 'Added while confirming')]}
          filePath="src/a.ts"
          showFileScope
          batch={{ size: 'sm' }}
        />
      </TooltipProvider>
    )
    expect(screen.getByText('Clear 1 note from src/a.ts?')).toBeVisible()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear Notes' }))
    })

    expect(deleteByIds).toHaveBeenCalledWith(OWNER, ['a1'])
  })
})
