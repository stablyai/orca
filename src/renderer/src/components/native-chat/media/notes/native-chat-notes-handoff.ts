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
import { sameNativeChatComposerDraftImages } from '../../drafts/native-chat-composer-draft-comparison'
import { slicePromptDocument } from '../../composer/editor/native-chat-prompt-document-text'
import { removeImageWithReferences } from '../../composer/editor/native-chat-composer-image-references'
import { nativeChatNotesSendWordsUnchanged } from './native-chat-notes-send-words'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'
import { drawNativeChatNotesImage } from './native-chat-media-notes-draw'
import {
  NativeChatNotesBlockedError,
  NativeChatNotesTooLargeError
} from './native-chat-notes-handoff-errors'
import {
  NATIVE_CHAT_NOTES_MAX_SOURCE_PIXELS,
  type NativeChatNotesBlocked
} from './native-chat-notes-reasons'
import { showNativeChatNotesNotice } from './native-chat-notes-notice'
import { translate } from '@/i18n/i18n'
import {
  groupNativeChatNotesByFrame,
  nativeChatNoteTimesNeedTenths,
  nativeChatNotesText,
  type NativeChatMediaNote
} from './native-chat-media-notes'

export { NativeChatNotesTooLargeError }
export {
  nativeChatNotesCloseErrorText,
  nativeChatNotesHandOffErrorText
} from './native-chat-notes-handoff-errors'

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

/** The mounted message box of this draft, wherever it is now (it may have remounted); null when
 *  none is mounted. */
export function nativeChatNotesComposerForScope(scopeKey: string): NativeChatNotesComposer | null {
  for (const element of document.querySelectorAll<HTMLElement>(
    '[data-native-chat-composer-scope]'
  )) {
    if (element.dataset.nativeChatComposerScope !== scopeKey) {
      continue
    }
    const box = nativeChatNotesComposer(element)
    if (box?.scopeKey === scopeKey) {
      return box
    }
  }
  return null
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
 *  back the images already attached and the text, and the notes stay in the viewer. Whether the
 *  message box can take notes is asked again before each image and before the text, as it may
 *  change while the images are prepared. */
export async function attachNativeChatNotes(args: {
  composer: NativeChatNotesComposer
  mediaName: string
  notes: readonly NativeChatMediaNote[]
  frame: NativeChatNotesFrameSource
  blocked: () => NativeChatNotesBlocked
}): Promise<NativeChatNotesAdded> {
  const { composer } = args
  // For a failure's clean-up only: the blank line a chip added after these words goes with it.
  const beforeText = readNativeChatComposerDraft(composer.scopeKey).text
  const attach = composer.handle.attachGeneratedImage
  if (!attach) {
    throw new Error('This message box cannot take images.')
  }
  const groups = groupNativeChatNotesByFrame(args.notes)
  const ids: string[] = []
  const stillTaking = (): void => {
    const blocked = args.blocked()
    if (blocked !== null) {
      throw new NativeChatNotesBlockedError(blocked)
    }
  }
  let added: NativeChatNotesAdded | null = null
  try {
    // One at a time, so only one full-size canvas exists at once.
    for (const group of groups) {
      stillTaking()
      const id = await queueNativeChatMediaWork(async () => {
        const drawable = await args.frame(group[0]?.time)
        try {
          if (drawable.width * drawable.height > NATIVE_CHAT_NOTES_MAX_SOURCE_PIXELS) {
            throw new NativeChatNotesTooLargeError()
          }
          return await attach(await drawNativeChatNotesImage(drawable.image, drawable, group))
        } finally {
          drawable.release?.()
        }
      })
      // A chat that can't take images keeps no image, and so no notes text either.
      if (!id || !nativeChatNotesStillInDraft(composer.scopeKey, [id])) {
        // A box that stopped taking notes meanwhile says why, rather than that the image failed.
        stillTaking()
        throw new Error('The marked image could not be attached.')
      }
      ids.push(id)
    }
    stillTaking()
    const precise = nativeChatNoteTimesNeedTenths(args.notes)
    const text = groups
      .map((group) => nativeChatNotesText(args.mediaName, group, precise))
      .join('\n\n')
    // Always its own text after the message, even when the message already ends in the same words
    // (the same notes added twice): each marked image has its notes beside it.
    const durable = appendToNativeChatComposerDraft(
      composer.scopeKey,
      { text },
      undefined,
      undefined,
      true
    )
    added = { ids, text }
    // Not journaled, the words could be lost to a crash before the draft is saved: they stay in the
    // viewer instead, as a hand-back keeps its source when its destination isn't durable.
    if (!durable) {
      throw new Error('The notes text could not be saved with the message.')
    }
    return added
  } catch (error) {
    // With no text added yet, only the images (and the blank line a chip added) go.
    takeOutNativeChatNotesHandOff(composer.scopeKey, added ?? { ids, text: '' }, beforeText)
    throw error
  }
}

/** Takes one hand-off's own additions out of the draft, its notes text after the message and its
 *  marked images, leaving everything else (any typing, a filled image, the editor's document) as
 *  it is. `beforeText`: the words before the hand-off, so the blank line a chip added after them
 *  goes with the chip. */
export function takeOutNativeChatNotesHandOff(
  scopeKey: string,
  added: NativeChatNotesAdded,
  beforeText: string
): void {
  // Whitespace the message box put after the notes text goes with it.
  const words = readNativeChatComposerDraft(scopeKey).text.trimEnd()
  const text = !added.text
    ? null
    : words === added.text
      ? ''
      : words.endsWith(`\n\n${added.text}`)
        ? words.slice(0, words.length - added.text.length - 2)
        : null
  if (text !== null) {
    setDraftWords(scopeKey, text)
  }
  for (const id of added.ids) {
    removeImageWithReferences(scopeKey, null, id)
  }
  const left = readNativeChatComposerDraft(scopeKey).text
  if (
    left !== beforeText &&
    left.startsWith(beforeText) &&
    left.slice(beforeText.length).trim() === ''
  ) {
    setDraftWords(scopeKey, beforeText)
  }
}

/** The draft's words cut back to `text`, a prefix of them, keeping the editor's document for it. */
function setDraftWords(scopeKey: string, text: string): void {
  const { document } = readNativeChatComposerDraft(scopeKey)
  updateNativeChatComposerDraft(
    scopeKey,
    {
      text,
      document: text && document ? slicePromptDocument(document, 0, text.length) : undefined
    },
    'immediate'
  )
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

// The same message: exactly the same words (line breaks too) and images (a filled placeholder
// keeps its id but not its path). The editor's document isn't compared: the message box rewrites
// it as it adopts a draft (NativeChatPromptEditor's onTransaction) without anyone typing, and
// Undo takes out only the hand-off's own additions, so a document-only change survives it.
const sameDraft = (a: NativeChatComposerDraft, b: NativeChatComposerDraft): boolean =>
  a.text === b.text && sameNativeChatComposerDraftImages(a.images, b.images)

/** "N notes added to your message" in the message box. Its Undo takes out exactly what the
 *  hand-off added (its marked images and its notes text) and nothing else. It is offered only when
 *  these notes are all that changed while the image was prepared (no typing, no image filled in),
 *  and only while the draft is exactly as the hand-off left it: any change since (typing, a line
 *  break, sending, removing a chip) ends the line. However the line ends, it stops watching the
 *  draft. */
export function announceNativeChatNotesHandOff(
  scopeKey: string,
  before: NativeChatComposerDraft,
  added: NativeChatNotesAdded,
  count: number
): void {
  const after = readNativeChatComposerDraft(scopeKey)
  const onlyTheseNotes =
    nativeChatNotesSendWordsUnchanged(
      before.text,
      withoutNotesText(after.text, added.text),
      added.ids,
      undefined
    ) &&
    after.images.map(({ id }) => id).join('\u0000') ===
      [...before.images.map(({ id }) => id), ...added.ids].join('\u0000') &&
    sameNativeChatComposerDraftImages(
      before.images,
      after.images.filter(({ id }) => !added.ids.includes(id))
    )
  let stop = (): void => {}
  const dismiss = showNativeChatNotesNotice(scopeKey, {
    text: translate(
      'components.native-chat.notes.addedToMessage',
      '{{count}} notes added to your message',
      { defaultValue_one: '{{count}} note added to your message', count }
    ),
    onEnd: () => stop(),
    ...(onlyTheseNotes
      ? {
          undo: () => {
            if (!sameDraft(readNativeChatComposerDraft(scopeKey), after)) {
              return
            }
            dismiss()
            takeOutNativeChatNotesHandOff(scopeKey, added, before.text)
          }
        }
      : {})
  })
  stop = subscribeToNativeChatComposerDraft(scopeKey, () => {
    if (!sameDraft(readNativeChatComposerDraft(scopeKey), after)) {
      dismiss()
    }
  })
}
