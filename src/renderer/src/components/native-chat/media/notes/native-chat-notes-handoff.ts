// Hands finished notes to the chat's message box as ordinary content: one marked image per media
// item (or video frame), attached like a pasted picture, and the numbered notes as text in the
// message. From then on they are the draft's own text and images, kept like anything typed or
// pasted there; nothing about the notes is stored anywhere else.

import { nativeChatComposerDestinationIn } from '../../composer/focus/native-chat-composer-destination'
import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import type { NativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-storage'
import { removeImageWithReferences } from '../../composer/editor/native-chat-composer-image-references'
import { nativeChatNotesSendWordsUnchanged } from './native-chat-notes-send-words'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'
import { drawNativeChatNotesImage } from './native-chat-media-notes-draw'
import { NativeChatNotesTooLargeError } from './native-chat-notes-handoff-errors'
import { NATIVE_CHAT_NOTES_MAX_SOURCE_PIXELS } from './native-chat-notes-reasons'
import { showNativeChatNotesNotice } from './native-chat-notes-notice'
import { translate } from '@/i18n/i18n'
import {
  groupNativeChatNotesByFrame,
  nativeChatNoteTimesNeedTenths,
  nativeChatNotesText,
  type NativeChatMediaNote
} from './native-chat-media-notes'

export { NativeChatNotesTooLargeError }
export { nativeChatNotesHandOffErrorText } from './native-chat-notes-handoff-errors'

/** `element`: the message box's mounted element. Its handle object is replaced as the box
 *  re-renders (attaching the marked image does), so the element is what tells one mounted box from
 *  another. */
export type NativeChatNotesComposer = {
  scopeKey: string
  handle: NativeChatComposerHandle
  element?: HTMLElement
}

/** The chat's message box, found from inside its chat; null outside a chat or with no box. */
export function nativeChatNotesComposer(from: Element | null): NativeChatNotesComposer | null {
  const root = from?.closest<HTMLElement>('[data-native-chat-root]') ?? null
  const destination = root ? nativeChatComposerDestinationIn(root) : null
  const scopeKey = destination?.element.dataset.nativeChatComposerScope
  return destination && scopeKey
    ? { scopeKey, handle: destination.handle, element: destination.element }
    : null
}

/** What one hand-off put in the draft: its marked images and the notes text after the message. */
export type NativeChatNotesAdded = { ids: readonly string[]; text: string }

/** What Send was pressed against: the chat, the message box instance, and the draft as it was. */
export type NativeChatNotesSendApproval = {
  root: Element | null
  composer: NativeChatNotesComposer
  /** The message box's mounted element at the press: a remount is another box. */
  element: HTMLElement | undefined
  text: string
  imageIds: readonly string[]
}

export function captureNativeChatNotesSend(
  opener: { readonly current: Element | null },
  composer: NativeChatNotesComposer
): NativeChatNotesSendApproval {
  const draft = readNativeChatComposerDraft(composer.scopeKey)
  const root = opener.current?.closest('[data-native-chat-root]') ?? null
  return {
    root,
    composer,
    element: (root ? nativeChatNotesComposer(root)?.element : undefined) ?? composer.element,
    text: draft.text,
    imageIds: draft.images.map(({ id }) => id)
  }
}

/** The draft's words without the notes text one hand-off appended after the message. */
function withoutNotesText(text: string, notesText: string): string {
  return text.endsWith(notesText) ? text.slice(0, text.length - notesText.length).trimEnd() : text
}

/** Sends the message the notes went into, only if it is still the one Send was pressed for: the same
 *  message box instance, still taking notes as a message, with the draft changed only by these
 *  marked images and their notes text. Otherwise they stay in the message box. */
export function submitNativeChatNotesIfApproved(
  approved: NativeChatNotesSendApproval,
  added: NativeChatNotesAdded
): boolean {
  const now = approved.root ? nativeChatNotesComposer(approved.root) : null
  const { scopeKey } = approved.composer
  const draft = readNativeChatComposerDraft(scopeKey)
  const expected = [...approved.imageIds, ...added.ids]
  if (
    now?.scopeKey !== scopeKey ||
    // The same mounted message box; its current handle is the one that sends.
    now.element !== approved.element ||
    now.handle.notesBlocked?.() !== null ||
    // Only this hand-off changed the words; line breaks and indents are as they were.
    !nativeChatNotesSendWordsUnchanged(
      approved.text,
      withoutNotesText(draft.text, added.text),
      added.ids,
      undefined
    ) ||
    // The images that were there, in their order, then these.
    draft.images.map(({ id }) => id).join('\u0000') !== expected.join('\u0000')
  ) {
    return false
  }
  now.handle.submit?.()
  return true
}

/** A drawable frame of the media and its natural size. */
export type NativeChatNotesFrameSource = (
  time: number | undefined
) => Promise<{ image: CanvasImageSource; width: number; height: number; release?: () => void }>

// One media-work queue for the whole window: drawing and saving marked images never overlap, across
// viewers and chats, so at most one full-size canvas and one encoded image are alive at a time.
let mediaWork: Promise<unknown> = Promise.resolve()

/** Runs `work` after every earlier marked-image job has finished. */
export function queueNativeChatMediaWork<T>(work: () => Promise<T>): Promise<T> {
  const run = mediaWork.then(work)
  mediaWork = run.catch(() => undefined)
  return run
}

/** Draws, saves and attaches one marked image per frame, then appends the numbered notes after the
 *  message (journaled like any text the message box takes back). Nothing half-added: a failure takes
 *  back the images already attached and adds no text. */
export async function attachNativeChatNotes(args: {
  composer: NativeChatNotesComposer
  mediaName: string
  notes: readonly NativeChatMediaNote[]
  frame: NativeChatNotesFrameSource
}): Promise<NativeChatNotesAdded> {
  const { composer } = args
  const attach = composer.handle.attachGeneratedImage
  if (!attach) {
    throw new Error('This message box cannot take images.')
  }
  const groups = groupNativeChatNotesByFrame(args.notes)
  const ids: string[] = []
  try {
    // One at a time, so only one full-size canvas exists at once.
    for (const group of groups) {
      const id = await queueNativeChatMediaWork(async () => {
        const drawable = await args.frame(group[0]?.time)
        try {
          if (drawable.width * drawable.height > NATIVE_CHAT_NOTES_MAX_SOURCE_PIXELS) {
            throw new NativeChatNotesTooLargeError()
          }
          return attach(await drawNativeChatNotesImage(drawable.image, drawable, group))
        } finally {
          drawable.release?.()
        }
      })
      // A chat that can't take images keeps no image, and so no notes text either.
      if (!id || !nativeChatNotesStillInDraft(composer.scopeKey, [id])) {
        throw new Error('The marked image could not be attached.')
      }
      ids.push(id)
    }
  } catch (error) {
    for (const id of ids) {
      removeImageWithReferences(composer.scopeKey, null, id)
    }
    throw error
  }
  const precise = nativeChatNoteTimesNeedTenths(args.notes)
  const text = groups
    .map((group) => nativeChatNotesText(args.mediaName, group, precise))
    .join('\n\n')
  appendToNativeChatComposerDraft(composer.scopeKey, { text })
  return { ids, text }
}

/** Whether every one of these marked images is still in the draft, unsent and not removed. */
export function nativeChatNotesStillInDraft(scopeKey: string, ids: readonly string[]): boolean {
  const held = new Set(readNativeChatComposerDraft(scopeKey).images.map(({ id }) => id))
  return ids.every((id) => held.has(id))
}

/** Lets the message box render the new chips and text before its send reads them. */
export function afterComposerRender(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

// Spacing alone doesn't count as a change: the message box's editor rewrites it as it renders.
const words = (text: string): string => text.replace(/\s+/g, ' ').trim()
const sameDraft = (a: NativeChatComposerDraft, b: NativeChatComposerDraft): boolean =>
  words(a.text) === words(b.text) &&
  a.images.map(({ id }) => id).join('\u0000') === b.images.map(({ id }) => id).join('\u0000')

/** "N notes added to your message" with Undo in the message box. Undo puts the message back as it
 *  was before the hand-off, and is offered only while the draft is still as the hand-off left it:
 *  any change since (typing, sending, removing a chip) ends the line. */
export function announceNativeChatNotesHandOff(
  scopeKey: string,
  before: NativeChatComposerDraft,
  count: number
): void {
  const after = readNativeChatComposerDraft(scopeKey)
  let done = false
  let stop = (): void => {}
  const dismiss = showNativeChatNotesNotice(scopeKey, {
    text: translate(
      'components.native-chat.notes.addedToMessage',
      '{{count}} notes added to your message',
      { defaultValue_one: '{{count}} note added to your message', count }
    ),
    undo: () => {
      if (done || !sameDraft(readNativeChatComposerDraft(scopeKey), after)) {
        return
      }
      done = true
      stop()
      updateNativeChatComposerDraft(
        scopeKey,
        { text: before.text, document: before.document, images: before.images },
        'immediate'
      )
    }
  })
  stop = subscribeToNativeChatComposerDraft(scopeKey, () => {
    if (!done && !sameDraft(readNativeChatComposerDraft(scopeKey), after)) {
      done = true
      stop()
      dismiss()
    }
  })
}
