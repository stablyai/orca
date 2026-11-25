// Hands finished notes to the chat's message box: one marked image per media item (or video frame),
// attached like a pasted picture, with its notes kept on that attachment.

import { nativeChatComposerDestinationIn } from '../../composer/focus/native-chat-composer-destination'
import {
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { removeImageWithReferences } from '../../composer/editor/native-chat-composer-image-references'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'
import {
  clearNativeChatAttachmentNotes,
  setNativeChatAttachmentNotes,
  type NativeChatNotesSource
} from './native-chat-attachment-notes'
import { drawNativeChatNotesImage } from './native-chat-media-notes-draw'
import { showNativeChatNotesNotice } from './native-chat-notes-notice'
import { translate } from '@/i18n/i18n'
import { groupNativeChatNotesByFrame, type NativeChatMediaNote } from './native-chat-media-notes'

export type NativeChatNotesComposer = { scopeKey: string; handle: NativeChatComposerHandle }

/** The chat's message box, found from inside its chat; null outside a chat or with no box. */
export function nativeChatNotesComposer(from: Element | null): NativeChatNotesComposer | null {
  const root = from?.closest<HTMLElement>('[data-native-chat-root]') ?? null
  // The draft the image goes into and the draft its notes are kept with are the same message box's.
  const destination = root ? nativeChatComposerDestinationIn(root) : null
  const scopeKey = destination?.element.dataset.nativeChatComposerScope
  return destination && scopeKey ? { scopeKey, handle: destination.handle } : null
}

/** The chat's draft scope, even while its message box is hidden behind a question card. */
export function nativeChatNotesScopeKey(from: Element | null): string | undefined {
  const root = from?.closest<HTMLElement>('[data-native-chat-root]')
  const composers = root?.querySelectorAll<HTMLElement>('[data-native-chat-composer-scope]')
  return composers ? [...composers].at(-1)?.dataset.nativeChatComposerScope : undefined
}

/** Storage refused the notes: they are only in this window's memory. */
export class NativeChatNotesUnsavedError extends Error {
  constructor() {
    super('The notes could not be saved.')
  }
}

/** What the notes replace left the draft while they were prepared. */
export class NativeChatNotesSupersededError extends Error {
  constructor() {
    super('The image these notes replace is no longer in the draft.')
  }
}

/** What a hand-off's `onAttached` returned, settled: false means the image these notes replace left
 *  the draft meanwhile (sent, or replaced from another viewer), so the marked copy is taken back out
 *  rather than bring back what is already gone. */
export function settleNativeChatNotesReplacement(
  scopeKey: string,
  ids: readonly string[],
  restore: (() => void) | void | false
): (() => void) | undefined {
  if (restore === false) {
    detachNativeChatNotes(scopeKey, ids)
    throw new NativeChatNotesSupersededError()
  }
  return restore ?? undefined
}

/** What Send was pressed against: the chat (its root outlives a chip that the marked copy replaces),
 *  the message box instance, and the draft as it was. */
export type NativeChatNotesSendApproval = {
  root: Element | null
  composer: NativeChatNotesComposer
  text: string
  imageIds: readonly string[]
}

export function captureNativeChatNotesSend(
  opener: { readonly current: Element | null },
  composer: NativeChatNotesComposer
): NativeChatNotesSendApproval {
  const draft = readNativeChatComposerDraft(composer.scopeKey)
  return {
    root: opener.current?.closest('[data-native-chat-root]') ?? null,
    composer,
    text: draft.text,
    imageIds: draft.images.map(({ id }) => id)
  }
}

/** Sends the message the notes went into, only if it is still the one Send was pressed for: the same
 *  message box instance, still taking notes as a message, with the draft changed only by these
 *  marked images (and the chip they replace). Otherwise the images stay in the message box. */
export function submitNativeChatNotesIfApproved(
  approved: NativeChatNotesSendApproval,
  ids: readonly string[],
  replacedId: string | undefined
): boolean {
  const now = approved.root ? nativeChatNotesComposer(approved.root) : null
  const { scopeKey } = approved.composer
  const draft = readNativeChatComposerDraft(scopeKey)
  const expected = new Set([...approved.imageIds.filter((id) => id !== replacedId), ...ids])
  if (
    now?.scopeKey !== scopeKey ||
    now.handle !== approved.composer.handle ||
    now.handle.notesBlocked?.() !== null ||
    draft.text !== approved.text ||
    draft.images.length !== expected.size ||
    draft.images.some(({ id }) => !expected.has(id))
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

/** Draws, saves and attaches one marked image per frame; resolves the new attachment ids in order. */
export async function attachNativeChatNotes(args: {
  composer: NativeChatNotesComposer
  mediaName: string
  kind: 'image' | 'video'
  source: NativeChatNotesSource
  notes: readonly NativeChatMediaNote[]
  offset: number
  frame: NativeChatNotesFrameSource
}): Promise<string[]> {
  const { composer } = args
  const attach = composer.handle.attachGeneratedImage
  if (!attach) {
    throw new Error('This message box cannot take images.')
  }
  const ids: string[] = []
  try {
    // One at a time, so only one full-size canvas exists at once.
    for (const group of groupNativeChatNotesByFrame(args.notes)) {
      const id = await queueNativeChatMediaWork(async () => {
        const drawable = await args.frame(group[0]?.time)
        let blob: Blob
        try {
          blob = await drawNativeChatNotesImage(drawable.image, drawable, group)
        } finally {
          drawable.release?.()
        }
        return attach(blob)
      })
      // A chat that can't take images keeps the file as a text reference: no image, no notes.
      if (
        !id ||
        !readNativeChatComposerDraft(composer.scopeKey).images.some((image) => image.id === id)
      ) {
        throw new Error('The marked image could not be attached.')
      }
      ids.push(id)
      const saved = setNativeChatAttachmentNotes(composer.scopeKey, id, {
        mediaName: args.mediaName,
        source: args.source,
        kind: args.kind,
        notes: group,
        offset: args.offset
      })
      // The image is saved with the draft; notes only in memory would leave it without them after a
      // reload, so the pair goes back and the words stay in the viewer.
      if (!saved) {
        throw new NativeChatNotesUnsavedError()
      }
    }
  } catch (error) {
    // Nothing half-attached: a failed batch takes back what it already added.
    detachNativeChatNotes(composer.scopeKey, ids)
    throw error
  }
  return ids
}

/** Removes marked images (and their notes) that are still in the draft. */
export function detachNativeChatNotes(scopeKey: string, ids: readonly string[]): void {
  for (const id of ids) {
    removeImageWithReferences(scopeKey, null, id)
  }
  clearNativeChatAttachmentNotes(scopeKey, ids)
}

/** Whether every one of these marked images is still in the draft, unsent and not removed. */
export function nativeChatNotesStillInDraft(scopeKey: string, ids: readonly string[]): boolean {
  const held = new Set(readNativeChatComposerDraft(scopeKey).images.map(({ id }) => id))
  return ids.every((id) => held.has(id))
}

/** Calls `onLeft` once, as soon as any of these images leaves the draft (sent, removed or reopened). */
export function watchNativeChatNotesLeaveDraft(
  scopeKey: string,
  ids: readonly string[],
  onLeft: () => void
): () => void {
  let done = false
  const stop = subscribeToNativeChatComposerDraft(scopeKey, () => {
    if (!done && !nativeChatNotesStillInDraft(scopeKey, ids)) {
      done = true
      stop()
      onLeft()
    }
  })
  return () => {
    done = true
    stop()
  }
}

/** Lets the message box render the new chips before its send reads them. */
export function afterComposerRender(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

/** "N notes added to your message" with Undo in the message box, live only while those images are
 *  still in the draft and not reopened. */
export function announceNativeChatNotesHandOff(
  scopeKey: string,
  ids: string[],
  undo: () => void,
  count: number
): void {
  const dismiss = showNativeChatNotesNotice(scopeKey, {
    text: translate(
      'components.native-chat.notes.addedToMessage',
      '{{count}} notes added to your message',
      { defaultValue_one: '{{count}} note added to your message', count }
    ),
    ids,
    undo: () => {
      if (nativeChatNotesStillInDraft(scopeKey, ids)) {
        detachNativeChatNotes(scopeKey, ids)
        undo()
      }
    }
  })
  watchNativeChatNotesLeaveDraft(scopeKey, ids, dismiss)
}
