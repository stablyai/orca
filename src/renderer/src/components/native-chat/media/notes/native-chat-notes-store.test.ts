// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { deleteNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-removal'
import { moveNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-move'
import { deferredRemovals } from '../../drafts/native-chat-composer-draft-memory'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import {
  NATIVE_CHAT_ATTACHMENT_NOTES_MAX,
  clearNativeChatAttachmentNotes,
  readNativeChatAttachmentNotes,
  resetNativeChatAttachmentNotesForTests,
  setNativeChatAttachmentNotes,
  type NativeChatAttachmentNotes
} from './native-chat-attachment-notes'
import {
  holdNativeChatNotes,
  resetNativeChatHeldNotesForTests,
  readHeldNativeChatNotes,
  releaseHeldNativeChatNotes
} from './native-chat-held-notes'
import { restoreNativeChatCleanImage, takeNativeChatNotedImage } from './native-chat-chip-notes'
import {
  resetNativeChatNotesNoticesForTests,
  showNativeChatNotesNotice,
  useNativeChatNotesNotice
} from './native-chat-notes-notice'
import { act, renderHook } from '@testing-library/react'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'
import { attachNativeChatNotes, queueNativeChatMediaWork } from './native-chat-notes-handoff'
import { nativeChatSentNotesNumberMax, type NativeChatMediaNote } from './native-chat-media-notes'

vi.mock('./native-chat-media-notes-draw', () => ({
  drawNativeChatNotesImage: async () => new Blob(['png'], { type: 'image/png' })
}))

const SCOPE = 'agent-session:notes'
const ATTACHMENT_NOTES_KEY = 'orca.nativeChat.attachmentNotes.v1'
const note = (number: number, text = `Note ${number}`): NativeChatMediaNote => ({
  id: `n${number}`,
  number,
  text,
  mark: { kind: 'pin', x: 0.5, y: 0.5 }
})
const record = (notes: NativeChatMediaNote[]): NativeChatAttachmentNotes => ({
  mediaName: 'dashboard.png',
  source: { path: '/tmp/dashboard.png' },
  kind: 'image',
  notes,
  offset: 0
})
const imageIds = (scope = SCOPE) => readNativeChatComposerDraft(scope).images.map(({ id }) => id)

beforeEach(() => {
  localStorage.clear()
  clearNativeChatComposerDraftsForTests()
  resetNativeChatAttachmentNotesForTests()
  resetNativeChatHeldNotesForTests()
  resetNativeChatNotesNoticesForTests()
})

it('keeps held notes across a reload and drops them with their chat’s draft', () => {
  holdNativeChatNotes(SCOPE, '/tmp/dashboard.png', [note(1), note(2)])
  holdNativeChatNotes('agent-session:other', '/tmp/dashboard.png', [note(1)])
  resetNativeChatHeldNotesForTests()
  // Reading them back for a viewer keeps them held: a restart before they're handed off loses none.
  expect(readHeldNativeChatNotes(SCOPE, '/tmp/dashboard.png')?.map(({ id }) => id)).toEqual([
    'n1',
    'n2'
  ])
  resetNativeChatHeldNotesForTests()
  expect(readHeldNativeChatNotes(SCOPE, '/tmp/dashboard.png')).toHaveLength(2)
  releaseHeldNativeChatNotes(SCOPE, '/tmp/dashboard.png')
  expect(readHeldNativeChatNotes(SCOPE, '/tmp/dashboard.png')).toBeNull()
  deleteNativeChatComposerDraft('agent-session:other')
  expect(readHeldNativeChatNotes('agent-session:other', '/tmp/dashboard.png')).toBeNull()
})

it('takes a marked image out with its notes and puts both back on Undo', () => {
  appendToNativeChatComposerDraft(SCOPE, {
    text: '',
    images: [{ id: 'img-1', path: '/tmp/m.png' }]
  })
  setNativeChatAttachmentNotes(SCOPE, 'img-1', record([note(1), note(2)]))
  const putBack = takeNativeChatNotedImage(SCOPE, 'img-1')
  expect(imageIds()).toEqual([])
  expect(readNativeChatAttachmentNotes(SCOPE, 'img-1')).toBeNull()
  putBack()
  expect(imageIds()).toEqual(['img-1'])
  expect(readNativeChatAttachmentNotes(SCOPE, 'img-1')?.notes).toHaveLength(2)
})

it('a marked image whose notes were all deleted becomes its clean original, and Undo swaps back', () => {
  appendToNativeChatComposerDraft(SCOPE, {
    text: '',
    images: [{ id: 'img-1', path: '/tmp/m.png' }]
  })
  setNativeChatAttachmentNotes(SCOPE, 'img-1', record([note(1)]))
  const undo = restoreNativeChatCleanImage(SCOPE, 'img-1', record([note(1)]))
  expect(readNativeChatComposerDraft(SCOPE).images.map(({ path }) => path)).toEqual([
    '/tmp/dashboard.png'
  ])
  undo()
  expect(readNativeChatComposerDraft(SCOPE).images.map(({ path }) => path)).toEqual(['/tmp/m.png'])
  expect(readNativeChatAttachmentNotes(SCOPE, 'img-1')?.notes).toHaveLength(1)
})

it('ends the notes line once notes are sent, so its Undo no longer applies', () => {
  showNativeChatNotesNotice(SCOPE, { text: '2 notes removed', undo: () => {} })
  const line = renderHook(() => useNativeChatNotesNotice(SCOPE))
  expect(line.result.current?.action?.label).toBe('Undo')
  act(() => clearNativeChatAttachmentNotes(SCOPE, []))
  expect(line.result.current).toBeNull()
})

it('over the cap drops notes whose image left its draft, never notes on an image still in one', async () => {
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  // Before saved drafts load, no image is known to have left its draft: nothing is dropped.
  for (let index = 0; index <= NATIVE_CHAT_ATTACHMENT_NOTES_MAX; index += 1) {
    setNativeChatAttachmentNotes(SCOPE, `gone-${index}`, record([note(1)]))
  }
  expect(readNativeChatAttachmentNotes(SCOPE, 'gone-0')).not.toBeNull()
  await hydrateNativeChatComposerDrafts()
  appendToNativeChatComposerDraft(SCOPE, { text: '', images: [{ id: 'kept', path: '/tmp/k.png' }] })
  setNativeChatAttachmentNotes(SCOPE, 'kept', record([note(1)]))
  expect(readNativeChatAttachmentNotes(SCOPE, 'kept')).not.toBeNull()
  expect(readNativeChatAttachmentNotes(SCOPE, 'gone-0')).toBeNull()
})

it('a write keeps notes another window saved meanwhile', () => {
  setNativeChatAttachmentNotes(SCOPE, 'img-1', record([note(1)]))
  // Another window sharing this storage saves notes of its own.
  const stored: unknown[] = JSON.parse(localStorage.getItem(ATTACHMENT_NOTES_KEY) ?? '[]')
  localStorage.setItem(
    ATTACHMENT_NOTES_KEY,
    JSON.stringify([...stored, ['agent-session:other\u0000img-9', record([note(1)])]])
  )
  setNativeChatAttachmentNotes(SCOPE, 'img-2', record([note(1)]))
  resetNativeChatAttachmentNotesForTests()
  expect(readNativeChatAttachmentNotes('agent-session:other', 'img-9')).not.toBeNull()
  expect(readNativeChatAttachmentNotes(SCOPE, 'img-1')).not.toBeNull()
  expect(readNativeChatAttachmentNotes(SCOPE, 'img-2')).not.toBeNull()
})

it('a write storage refused is retried without undoing what another window saved or removed', () => {
  setNativeChatAttachmentNotes(SCOPE, 'removed-elsewhere', record([note(1)]))
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw new Error('QuotaExceededError')
  })
  expect(setNativeChatAttachmentNotes(SCOPE, 'img-1', record([note(1)]))).toBe(false)
  setItem.mockRestore()
  // Meanwhile another window removes one entry and saves one of its own.
  const stored: [string, unknown][] = JSON.parse(localStorage.getItem(ATTACHMENT_NOTES_KEY) ?? '[]')
  localStorage.setItem(
    ATTACHMENT_NOTES_KEY,
    JSON.stringify([
      ...stored.filter(([key]) => !key.endsWith('removed-elsewhere')),
      ['agent-session:other\u0000img-9', record([note(1)])]
    ])
  )
  expect(setNativeChatAttachmentNotes(SCOPE, 'img-2', record([note(1)]))).toBe(true)
  resetNativeChatAttachmentNotesForTests()
  expect(readNativeChatAttachmentNotes(SCOPE, 'img-1')).not.toBeNull()
  expect(readNativeChatAttachmentNotes(SCOPE, 'img-2')).not.toBeNull()
  expect(readNativeChatAttachmentNotes('agent-session:other', 'img-9')).not.toBeNull()
  expect(readNativeChatAttachmentNotes(SCOPE, 'removed-elsewhere')).toBeNull()
})

it('notes on a draft’s images, and notes held for its chat, follow the draft to its new scope', () => {
  const launch = 'native-chat-launch:pane'
  appendToNativeChatComposerDraft(launch, {
    text: '',
    images: [{ id: 'img-3', path: '/tmp/m.png' }]
  })
  setNativeChatAttachmentNotes(launch, 'img-3', record([note(1)]))
  holdNativeChatNotes(launch, '/tmp/dashboard.png', [note(1), note(2)])
  moveNativeChatComposerDraft(launch, SCOPE)
  expect(imageIds()).toEqual(['img-3'])
  expect(readNativeChatAttachmentNotes(SCOPE, 'img-3')?.notes).toHaveLength(1)
  expect(readHeldNativeChatNotes(SCOPE, '/tmp/dashboard.png')).toHaveLength(2)
  // The source keeps its copy exactly while its draft's removal waits for the destination's save.
  expect(readNativeChatAttachmentNotes(launch, 'img-3') !== null).toBe(deferredRemovals.has(launch))
})

it('a moved draft’s held notes join the notes its new chat already holds for the same media', () => {
  const launch = 'native-chat-launch:pane-held'
  holdNativeChatNotes(SCOPE, '/tmp/dashboard.png', [note(1, 'mine')])
  holdNativeChatNotes(launch, '/tmp/dashboard.png', [
    { ...note(1, 'moved'), id: 'moved-1' },
    { ...note(2, 'moved too'), id: 'moved-2' }
  ])
  moveNativeChatComposerDraft(launch, SCOPE)
  const held = readHeldNativeChatNotes(SCOPE, '/tmp/dashboard.png')
  expect(held?.map(({ number, text }) => `${number}:${text}`)).toEqual([
    '1:mine',
    '2:moved',
    '3:moved too'
  ])
})

it('a batch that fails part-way takes back the images it already attached', async () => {
  let attached = 0
  const attachGeneratedImage = vi.fn(async () => {
    attached += 1
    if (attached === 2) {
      return null
    }
    appendToNativeChatComposerDraft(SCOPE, {
      text: '',
      images: [{ id: `marked-${attached}`, path: `/tmp/marked-${attached}.png` }]
    })
    return `marked-${attached}`
  })
  const handle: NativeChatComposerHandle = {
    insertAgentReferences: () => false,
    focus: () => true,
    insertTypedText: () => false,
    acceptsText: () => true,
    appendText: () => {},
    handlePasteEvent: () => {},
    pasteFromClipboard: () => {},
    contains: () => false,
    attachGeneratedImage
  }
  await expect(
    attachNativeChatNotes({
      composer: { scopeKey: SCOPE, handle },
      mediaName: 'clip.mp4',
      kind: 'video',
      source: { path: '/tmp/clip.mp4' },
      notes: [
        { ...note(1), time: 1 },
        { ...note(2), time: 2 }
      ],
      offset: 0,
      frame: async () => ({ image: new Image(), width: 10, height: 10 })
    })
  ).rejects.toThrow()
  expect(imageIds()).toEqual([])
  expect(readNativeChatAttachmentNotes(SCOPE, 'marked-1')).toBeNull()
})

it('runs marked-image work one job at a time', async () => {
  const order: string[] = []
  let finishFirst = () => {}
  const first = queueNativeChatMediaWork(
    () =>
      new Promise<void>((resolve) => {
        order.push('first started')
        finishFirst = () => {
          order.push('first done')
          resolve()
        }
      })
  )
  const second = queueNativeChatMediaWork(async () => {
    order.push('second started')
  })
  await Promise.resolve()
  expect(order).toEqual(['first started'])
  finishFirst()
  await Promise.all([first, second])
  expect(order).toEqual(['first started', 'first done', 'second started'])
})

it('reads the highest note number already drawn into a sent message’s marked images', () => {
  expect(
    nativeChatSentNotesNumberMax(
      'Fix these.\n\nNotes on a.png (numbered marks in the attached image):\n1. One\n2. Two\n\nNotes on b.png (numbered marks in the attached image):\n3. Three\nThanks'
    )
  ).toBe(3)
  expect(nativeChatSentNotesNumberMax('1. Not a notes list')).toBe(0)
})

it('refuses a hand-off when the chat keeps the image only as a file reference (F16)', async () => {
  const handle: NativeChatComposerHandle = {
    insertAgentReferences: () => false,
    focus: () => true,
    insertTypedText: () => false,
    acceptsText: () => true,
    appendText: () => {},
    handlePasteEvent: () => {},
    pasteFromClipboard: () => {},
    contains: () => false,
    // Saved, but settled as a text path: no draft image carries this id.
    attachGeneratedImage: async () => 'settled-as-path'
  }
  await expect(
    attachNativeChatNotes({
      composer: { scopeKey: SCOPE, handle },
      mediaName: 'dashboard.png',
      kind: 'image',
      source: { path: '/tmp/dashboard.png' },
      notes: [note(1)],
      offset: 0,
      frame: async () => ({ image: new Image(), width: 10, height: 10 })
    })
  ).rejects.toThrow()
  expect(readNativeChatAttachmentNotes(SCOPE, 'settled-as-path')).toBeNull()
})
