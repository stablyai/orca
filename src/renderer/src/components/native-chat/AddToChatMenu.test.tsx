// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AddToChatPointMenuHost, openAddToChatMenuAt } from './AddToChatMenu'

vi.mock('@/components/editor/review-note-delivery/ReviewNotesSendMenuContent', () => ({
  ReviewNotesSendMenuContent: () => <div role="menuitem">Chat A</div>
}))

afterEach(cleanup)

// The menu opens from a hidden anchor; cancelling it must hand focus back to the selection's editor.
it('returns focus to where the selection was when the menu is dismissed with Escape', async () => {
  render(
    <>
      <textarea aria-label="editor" />
      <AddToChatPointMenuHost />
    </>
  )
  const editor = screen.getByLabelText('editor')
  editor.focus()
  act(() =>
    openAddToChatMenuAt({ worktreeId: 'wt', quote: '> q', launchSource: 'native_chat', x: 1, y: 1 })
  )
  expect(screen.getByText('Chat A')).toBeTruthy()
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  expect(screen.queryByText('Chat A')).toBeNull()
  // Radix hands focus back a task after the menu unmounts.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(document.activeElement).toBe(editor)
})
