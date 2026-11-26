// @vitest-environment happy-dom
// Undo of a marked chip's Remove, replacement and Clear puts the draft back as it was: the chip in
// its place (so the numbering holds) and its inline references in the words. An Undo that can't put
// it back says so and offers Undo again.
import { createElement } from 'react'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { NativeChatImageAttachmentPreview } from '../../attachments/chips/NativeChatImageAttachmentPreview'
import {
  readNativeChatAttachmentNotes,
  resetNativeChatAttachmentNotesForTests,
  setNativeChatAttachmentNotes,
  type NativeChatAttachmentNotes
} from './native-chat-attachment-notes'
import {
  replaceNativeChatNotedImage,
  restoreNativeChatCleanImage,
  takeNativeChatNotedImage
} from './native-chat-chip-notes'
import { detachNativeChatNotes } from './native-chat-notes-handoff'
import {
  resetNativeChatNotesNoticesForTests,
  useNativeChatNotesNotice
} from './native-chat-notes-notice'

const SCOPE = 'agent-session:undo'
const NOTES: NativeChatAttachmentNotes = {
  mediaName: 'a.png',
  source: { path: '/tmp/a.png' },
  kind: 'image',
  notes: [{ id: 'n1', number: 1, text: 'the words', mark: { kind: 'pin', x: 0.5, y: 0.5 } }],
  offset: 0
}
const A = '[Image](orca-image:a)'
const B = '[Image](orca-image:b)'
const TEXT = `see ${A} and again ${A} next to ${B} please`
const draft = () => {
  const { text, images } = readNativeChatComposerDraft(SCOPE)
  return { text, ids: images.map(({ id }) => id) }
}

beforeEach(async () => {
  localStorage.clear()
  clearNativeChatComposerDraftsForTests()
  resetNativeChatAttachmentNotesForTests()
  resetNativeChatNotesNoticesForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
  appendToNativeChatComposerDraft(SCOPE, {
    images: [
      { id: 'a', path: '/tmp/a-notes.png' },
      { id: 'b', path: '/tmp/b.png' }
    ]
  })
  updateNativeChatComposerDraft(SCOPE, { text: TEXT }, 'immediate')
  setNativeChatAttachmentNotes(SCOPE, 'a', NOTES)
})
afterEach(() => vi.restoreAllMocks())

it('Undo of Remove puts the chip back in its place, with both its references', () => {
  const putBack = takeNativeChatNotedImage(SCOPE, 'a')
  expect(draft().ids).toEqual(['b'])
  expect(putBack()).toBe(true)
  expect(draft()).toEqual({ text: TEXT, ids: ['a', 'b'] })
  expect(readNativeChatAttachmentNotes(SCOPE, 'a')?.notes[0]?.text).toBe('the words')
})

it('Undo of a replacement puts the chip back where its marked copy took over', () => {
  // The marked copy is attached at the end, then takes the chip's place.
  appendToNativeChatComposerDraft(SCOPE, { images: [{ id: 'm', path: '/tmp/m.png' }] })
  updateNativeChatComposerDraft(SCOPE, { text: `${TEXT} [Image](orca-image:m) ` }, 'immediate')
  const restore = replaceNativeChatNotedImage(SCOPE, 'a')
  expect(restore && restore()).toBe(true)
  detachNativeChatNotes(SCOPE, ['m'])
  // Exactly as before, but for the space the copy's chip came with, which stays when it goes.
  expect(draft()).toEqual({ text: `${TEXT} `, ids: ['a', 'b'] })
})

it('Undo of Clear puts the marked chip back in its place, not the clean one', () => {
  const putBack = restoreNativeChatCleanImage(SCOPE, 'a', NOTES)
  expect(draft().ids).toEqual(['b', expect.stringMatching(/^notes-clean-/)])
  expect(putBack()).toBe(true)
  expect(draft()).toEqual({ text: TEXT, ids: ['a', 'b'] })
})

it('an Undo that can’t put the chip back with its notes says so, and Undo again does', () => {
  render(
    createElement(NativeChatImageAttachmentPreview, {
      attachment: { id: 'a', path: '/tmp/a-notes.png' },
      notesScopeKey: SCOPE,
      onRemove: vi.fn()
    })
  )
  const line = renderHook(() => useNativeChatNotesNotice(SCOPE))
  fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }))
  // Storage refuses the notes as Undo puts them back.
  const refused = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError')
  })
  act(() => line.result.current?.action?.onClick())
  expect(line.result.current?.text).toBe(
    'Couldn’t put the image back with its notes. Try Undo again.'
  )
  refused.mockRestore()
  act(() => line.result.current?.action?.onClick())
  expect(line.result.current).toBeNull()
  expect(draft().ids).toEqual(['a', 'b'])
  resetNativeChatAttachmentNotesForTests()
  expect(readNativeChatAttachmentNotes(SCOPE, 'a')?.notes[0]?.text).toBe('the words')
})
