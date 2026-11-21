// Hands finished notes to the chat's message box: one marked image per media item (or video frame),
// attached like a pasted picture, with its notes kept on that attachment.

import { nativeChatComposerDestination } from '../../composer/focus/native-chat-composer-destination'
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
import { groupNativeChatNotesByFrame, type NativeChatMediaNote } from './native-chat-media-notes'

export type NativeChatNotesComposer = { scopeKey: string; handle: NativeChatComposerHandle }

/** The chat's message box, found from inside its chat; null outside a chat or with no box. */
export function nativeChatNotesComposer(from: Element | null): NativeChatNotesComposer | null {
  const root = from?.closest<HTMLElement>('[data-native-chat-root]') ?? null
  const scopeKey = nativeChatNotesScopeKey(from)
  const handle = root ? nativeChatComposerDestination(root, null) : null
  return scopeKey && handle ? { scopeKey, handle } : null
}

/** The chat's draft scope, even while its message box is hidden behind a question card. */
export function nativeChatNotesScopeKey(from: Element | null): string | undefined {
  const root = from?.closest<HTMLElement>('[data-native-chat-root]')
  const composers = root?.querySelectorAll<HTMLElement>('[data-native-chat-composer-scope]')
  return composers ? [...composers].at(-1)?.dataset.nativeChatComposerScope : undefined
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
      setNativeChatAttachmentNotes(composer.scopeKey, id, {
        mediaName: args.mediaName,
        source: args.source,
        kind: args.kind,
        notes: group,
        offset: args.offset
      })
      ids.push(id)
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
