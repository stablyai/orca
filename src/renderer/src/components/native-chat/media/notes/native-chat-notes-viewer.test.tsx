// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { useLayoutEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeChatMediaViewer } from './NativeChatMediaViewer'
import { useNativeChatNotesEditor } from './use-native-chat-notes-editor'
import type { NativeChatMediaNote } from './native-chat-media-notes'
import { registerNativeChatComposerDestination } from '../../composer/focus/native-chat-composer-destination'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'
import {
  resetNativeChatNotesNoticesForTests,
  useNativeChatNotesNotice
} from './native-chat-notes-notice'
import { appendToNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { resetNativeChatAttachmentNotesForTests } from './native-chat-attachment-notes'
import { resetNativeChatHeldNotesForTests, takeHeldNativeChatNotes } from './native-chat-held-notes'

vi.mock('./native-chat-media-notes-draw', () => ({
  drawNativeChatNotesImage: async () => new Blob(['png'], { type: 'image/png' })
}))

const SCOPE = 'agent-session:viewer'
const SRC = 'blob:sample'
const IGNORE_OPEN_CHANGE = (): void => {}

beforeEach(() => {
  localStorage.clear()
  clearNativeChatComposerDraftsForTests()
  resetNativeChatAttachmentNotesForTests()
  resetNativeChatHeldNotesForTests()
  resetNativeChatNotesNoticesForTests()
})
afterEach(cleanup)

function composerStub(overrides: Partial<NativeChatComposerHandle>): NativeChatComposerHandle {
  return {
    insertAgentReferences: () => false,
    focus: () => true,
    insertTypedText: () => false,
    acceptsText: () => true,
    appendText: () => {},
    handlePasteEvent: () => {},
    pasteFromClipboard: () => {},
    contains: () => false,
    notesBlocked: () => null,
    ...overrides
  }
}

/** A chat with a message box `composer`, and the viewer opened from a button inside it. */
function Chat({
  composer,
  onOpenChange = IGNORE_OPEN_CHANGE,
  initialNotes
}: {
  composer: NativeChatComposerHandle
  onOpenChange?: (open: boolean) => void
  initialNotes?: readonly NativeChatMediaNote[]
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useLayoutEffect(
    () =>
      box.current
        ? registerNativeChatComposerDestination(box.current, { current: composer }, true, SCOPE)
        : undefined,
    [composer]
  )
  return (
    <div data-native-chat-root="true">
      <div ref={box} data-native-chat-composer-scope={SCOPE} />
      <button type="button" onClick={() => setOpen(true)}>
        Open image
      </button>
      <NativeChatMediaViewer
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          onOpenChange(next)
        }}
        src={SRC}
        title="dashboard.png"
        source={{ path: '/tmp/dashboard.png' }}
        opener={box}
        initialNotes={initialNotes}
        fallback={<span>Image unavailable</span>}
      />
    </div>
  )
}

/** Opens the viewer and lets its hidden loader report a 400×300 image. */
function openLoaded(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Open image' }))
  const loader = document.querySelector<HTMLImageElement>('img.hidden')!
  Object.defineProperty(loader, 'naturalWidth', { value: 400 })
  Object.defineProperty(loader, 'naturalHeight', { value: 300 })
  fireEvent.load(loader)
}

/** Annotate, pin the middle from the keyboard, and type a note. */
function writeNote(text: string): void {
  const viewport = screen.getByRole('application')
  fireEvent.keyDown(viewport, { key: 'Enter' })
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
}

function startAnnotating(): void {
  fireEvent.click(screen.getByRole('button', { name: /Annotate/ }))
}

it('a note written after Undo gets the next number, never a duplicate (F7)', () => {
  const { result } = renderHook(() => useNativeChatNotesEditor({}))
  for (const text of ['a', 'b', 'c']) {
    act(() => {
      result.current.place({ kind: 'pin', x: 0.5, y: 0.5 })
    })
    act(() => result.current.setDraftText(text))
    act(() => {
      result.current.commit()
    })
  }
  act(() => result.current.remove(result.current.notes[1]!.id))
  act(() => {
    result.current.place({ kind: 'pin', x: 0.2, y: 0.2 })
  })
  act(() => result.current.setDraftText('d'))
  act(() => {
    result.current.undo()
  })
  act(() => {
    result.current.commit()
  })
  expect(result.current.notes.map((note) => `${note.number}:${note.text}`)).toEqual([
    '1:a',
    '2:b',
    '3:c',
    '4:d'
  ])
})

it('shows the fallback for an image that fails to load, not a blank viewer (F10)', () => {
  render(<Chat composer={composerStub({})} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open image' }))
  fireEvent.error(document.querySelector('img.hidden')!)
  expect(screen.getByText('Image unavailable')).toBeTruthy()
})

it('gives focus back to what opened it when it closes (F9)', async () => {
  render(<Chat composer={composerStub({})} />)
  const opener = screen.getByRole('button', { name: 'Open image' })
  opener.focus()
  fireEvent.click(opener)
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  // The dialog hands focus back after it unmounts.
  await vi.waitFor(() => expect(document.activeElement).toBe(opener))
})

it('closes in one step after the close prompt adds the open note (F8)', async () => {
  const onOpenChange = vi.fn()
  // A command in the box: the notes are kept with the image, so closing needs no hand-off.
  render(
    <Chat composer={composerStub({ notesBlocked: () => 'command' })} onOpenChange={onOpenChange} />
  )
  openLoaded()
  startAnnotating()
  writeNote('Align this')
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
  })
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(takeHeldNativeChatNotes(SCOPE, '/tmp/dashboard.png')?.map(({ text }) => text)).toEqual([
    'Align this'
  ])
})

it('Esc while Send is still preparing starts no second hand-off, and a held-back send says so (F3, F15)', async () => {
  let finish: (id: string | null) => void = () => {}
  const attachGeneratedImage = vi.fn(
    () =>
      new Promise<string | null>((resolve) => {
        finish = (id) => {
          if (id) {
            appendToNativeChatComposerDraft(SCOPE, {
              text: '',
              images: [{ id, path: '/tmp/marked.png' }]
            })
          }
          resolve(id)
        }
      })
  )
  // Submit sends nothing (another upload is still pending): the marked image stays in the draft.
  const composer = composerStub({ attachGeneratedImage, submit: () => {} })
  render(<Chat composer={composer} />)
  const notice = renderHook(() => useNativeChatNotesNotice(SCOPE))
  openLoaded()
  startAnnotating()
  writeNote('Too thin')
  fireEvent.click(screen.getByRole('button', { name: /^Add\b/ }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Send 1 note to this chat/ }))
  })
  // Esc leaves annotating, then asks to close while Send is still preparing.
  for (let press = 0; press < 2; press += 1) {
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    })
  }
  await act(async () => {
    finish('marked-1')
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(attachGeneratedImage).toHaveBeenCalledTimes(1)
  // The notice follows the composer's render after the held-back submit.
  await vi.waitFor(() => expect(notice.result.current?.text).toBe('1 note added to your message'))
  expect(attachGeneratedImage).toHaveBeenCalledTimes(1)
})

it('a note opened right after C keeps focus when the delayed media focus lands', () => {
  const frames: FrameRequestCallback[] = []
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  try {
    render(<Chat composer={composerStub({})} />)
    openLoaded()
    // C, then Enter before the next frame: the frame that focuses the media runs after the note opened.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'c' })
    fireEvent.keyDown(screen.getByRole('application'), { key: 'Enter' })
    const field = screen.getByRole('textbox', { name: 'New note' })
    expect(document.activeElement).toBe(field)
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    expect(document.activeElement).toBe(field)
  } finally {
    raf.mockRestore()
  }
})

it('reopened notes wait for their image before Send, and closing before then leaves them as they were', () => {
  const attachGeneratedImage = vi.fn(async () => 'marked-1')
  const onOpenChange = vi.fn()
  const notes = [
    { id: 'n1', number: 1, text: 'Align', mark: { kind: 'pin' as const, x: 0.5, y: 0.5 } }
  ]
  render(
    <Chat
      composer={composerStub({ attachGeneratedImage })}
      onOpenChange={onOpenChange}
      initialNotes={notes}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Open image' }))
  // The image is not read yet: Send can't draw the marks, so it isn't offered.
  const send = screen.getByRole('button', { name: /Send 1 note to this chat/ })
  expect(send).toHaveProperty('disabled', true)
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(attachGeneratedImage).not.toHaveBeenCalled()
})
