// @vitest-environment happy-dom
// Clearing every note of the first of three numbered chips puts its clean original in its place, at
// the end of the row; closing returns focus to that clean image, not the chip now numbered 1.
import { useRef, useState } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { NativeChatMediaViewer } from './NativeChatMediaViewer'
import { restoreNativeChatCleanImage } from './native-chat-chip-notes'
import type { NativeChatAttachmentNotes } from './native-chat-attachment-notes'

const SCOPE = 'agent-session:clear-focus'
const SRC =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/%3E'
const NOTES: NativeChatAttachmentNotes = {
  mediaName: 'a.png',
  source: { path: '/tmp/a.png' },
  kind: 'image',
  notes: [{ id: 'n1', number: 1, text: 'gone', mark: { kind: 'pin', x: 0.5, y: 0.5 } }],
  offset: 0
}

const ids = (): string[] => readNativeChatComposerDraft(SCOPE).images.map(({ id }) => id)

/** The message box's numbered chips; the first one's viewer, closed with every note cleared, puts
 *  the clean original in its place as the chip's Clear does. */
function NumberedChips(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [row, setRow] = useState(ids)
  const box = useRef<HTMLDivElement>(null)
  return (
    <div ref={box}>
      {row.map((id, at) => (
        <button
          key={id}
          type="button"
          data-native-chat-attachment-id={id}
          aria-label={`Image ${at + 1}: View image ${id}`}
          onClick={() => setOpen(true)}
        >
          {id}
        </button>
      ))}
      <NativeChatMediaViewer
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            restoreNativeChatCleanImage(SCOPE, 'a', NOTES)
            setRow(ids())
          }
          setOpen(next)
        }}
        src={SRC}
        title="a.png"
        source={{ path: '/tmp/a.png' }}
        opener={box}
        annotatable={false}
      />
    </div>
  )
}

beforeEach(async () => {
  localStorage.clear()
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
  appendToNativeChatComposerDraft(SCOPE, {
    text: '',
    images: ['a', 'b', 'c'].map((id) => ({ id, path: `/tmp/${id}.png` }))
  })
})

it('closing after Clear returns focus to the clean image, not the chip now numbered 1', async () => {
  const view = render(<NumberedChips />)
  const first = view.container.querySelector<HTMLButtonElement>(
    '[data-native-chat-attachment-id="a"]'
  )
  first?.focus()
  act(() => {
    first?.click()
  })
  await vi.waitFor(() =>
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true)
  )
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  })
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  const clean = ids().find((id) => id.startsWith('notes-clean-'))
  expect(clean).toBeDefined()
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute('data-native-chat-attachment-id')).toBe(clean)
  )
})
