import { formatNativeChatFileReference } from '../../../../../shared/native-chat/input/composer/agent-image-paste'
import type { JSONContent } from '@tiptap/react'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import type { NativeChatComposerDraftImage } from './native-chat-composer-draft-storage'
import { restoreNativeChatExpiredUploads } from './native-chat-staged-input'

/**
 * Expired uploads a hand-back could not restore because their staged originals were not this draft's
 * yet (a worktree's first send refused before its draft moved in), kept per recipient draft.
 * `images`: the unavailable chip it returned for each, by chip id, with the expired host path and
 * the name the chip shows. `text`: expired host paths in the returned text.
 */
type UnresolvedImage = { host: string; unavailableName: string | undefined }
const unrestored = new Map<string, { images: Map<string, UnresolvedImage>; text: Set<string> }>()

export function noteNativeChatUnrestoredExpiredUploads(
  scope: string,
  images: readonly NativeChatComposerDraftImage[],
  hosts: ReadonlyMap<string, string>,
  text: readonly string[]
): void {
  const chips = images.flatMap((image) => {
    const host = hosts.get(image.id)
    return host ? [[image.id, { host, unavailableName: image.unavailableName }] as const] : []
  })
  if (chips.length === 0 && text.length === 0) {
    return
  }
  const note = unrestored.get(scope) ?? { images: new Map(), text: new Set() }
  chips.forEach(([id, chip]) => note.images.set(id, chip))
  text.forEach((host) => note.text.add(host))
  unrestored.set(scope, note)
}

/** Literal replacement of each expired host reference, quoted or not, with its original. */
function rewriteReferences(value: string, restored: ReadonlyMap<string, string>): string {
  let next = value
  for (const [host, original] of restored) {
    next = next
      .split(formatNativeChatFileReference(host))
      .join(formatNativeChatFileReference(original))
      .split(host)
      .join(original)
  }
  return next
}

/** The same rewrite through the stored rich document, so its other content (skills, marks) survives. */
function rewriteDocument(node: JSONContent, restored: ReadonlyMap<string, string>): JSONContent {
  return {
    ...node,
    ...(node.text !== undefined ? { text: rewriteReferences(node.text, restored) } : {}),
    ...(node.attrs
      ? {
          attrs: Object.fromEntries(
            Object.entries(node.attrs).map(([key, value]) => [
              key,
              typeof value === 'string' ? rewriteReferences(value, restored) : value
            ])
          )
        }
      : {}),
    ...(node.content
      ? { content: node.content.map((child) => rewriteDocument(child, restored)) }
      : {})
  }
}

/**
 * Staged originals just moved into this draft: restore the expired uploads noted for it, as the
 * hand-back would have. Authority follows the unresolved reference itself: a chip is replaced only
 * while it is still the same unavailable placeholder (a newer image the user put in that slot wins,
 * and a removed chip stays removed), and only expired references still in the text are rewritten.
 * Only originals that moved into this draft are used.
 */
export function repairNativeChatExpiredUploads(scope: string): void {
  const note = unrestored.get(scope)
  if (!note) {
    return
  }
  unrestored.delete(scope)
  const draft = readNativeChatComposerDraft(scope)
  const unresolvedChips = new Map(
    draft.images.flatMap((image) => {
      const chip = note.images.get(image.id)
      return chip && image.path === '' && image.unavailableName === chip.unavailableName
        ? [[image.id, chip.host] as const]
        : []
    })
  )
  const unresolvedText = [...note.text].filter((host) => draft.text.includes(host))
  const restored = restoreNativeChatExpiredUploads(scope, [
    ...unresolvedChips.values(),
    ...unresolvedText
  ])
  // Still unresolved but its original is not here yet: keep waiting for the move that brings it.
  const waiting = {
    images: new Map(
      [...note.images].filter(([id, chip]) => unresolvedChips.has(id) && !restored.has(chip.host))
    ),
    text: new Set(unresolvedText.filter((host) => !restored.has(host)))
  }
  if (waiting.images.size > 0 || waiting.text.size > 0) {
    unrestored.set(scope, waiting)
  }
  if (restored.size === 0) {
    return
  }
  const images = draft.images.map((image) => {
    const original = restored.get(unresolvedChips.get(image.id) ?? '')
    return original ? { id: image.id, path: original } : image
  })
  const textRestored = new Map([...restored].filter(([host]) => unresolvedText.includes(host)))
  const text = rewriteReferences(draft.text, textRestored)
  updateNativeChatComposerDraft(
    scope,
    text === draft.text
      ? { images }
      : {
          images,
          text,
          document: draft.document && rewriteDocument(draft.document, textRestored)
        },
    'immediate'
  )
}

/** The draft is gone for good: nothing will move into it to repair. */
export function forgetNativeChatUnrestoredExpiredUploads(scope: string): void {
  unrestored.delete(scope)
}
