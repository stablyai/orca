import { formatNativeChatFileReference } from '../../../../../shared/native-chat/input/composer/agent-image-paste'
import { nativeChatTextAttachmentParts } from '../../../../../shared/native-chat/attachments/native-chat-text-attachment-references'
import type { JSONContent } from '@tiptap/react'
import { FILE_REFERENCE_NODE } from '../composer/editor/native-chat-prompt-document-text'
import {
  nativeChatDraftPositions,
  records,
  type NativeChatDraftPosition
} from './native-chat-composer-draft-memory'
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

/**
 * Rewrite only exact file references to an expired host path (the attachment parser's own tokens, quoted
 * or not), never a substring: `@…/file.txt.bak`, prose quoting the path and other atoms stay as they are.
 * `offset` maps a position in the old text to the new one.
 */
function rewriteReferences(
  value: string,
  restored: ReadonlyMap<string, string>
): { text: string; offset: (at: number) => number } {
  const parts = nativeChatTextAttachmentParts(value, true, (path) => restored.has(path))
  const shifts: { end: number; delta: number }[] = []
  let oldEnd = 0
  let delta = 0
  const text = parts
    .map((part) => {
      const next = part.path ? formatNativeChatFileReference(restored.get(part.path)!) : part.text
      oldEnd += part.text.length
      delta += next.length - part.text.length
      shifts.push({ end: oldEnd, delta })
      return next
    })
    .join('')
  // Shift by the length change of every part that ends at or before the position.
  const offset = (at: number): number => {
    let shift = 0
    for (const { end, delta: through } of shifts) {
      if (end > at) {
        break
      }
      shift = through
    }
    return at + shift
  }
  return { text, offset }
}

/** Expired references the text still holds as exact attachment tokens. */
function referencedHosts(text: string, hosts: readonly string[]): string[] {
  const exact = new Set(
    nativeChatTextAttachmentParts(text, true, (path) => hosts.includes(path)).flatMap((part) =>
      part.path ? [part.path] : []
    )
  )
  return hosts.filter((host) => exact.has(host))
}

/**
 * The same exact rewrite through the stored rich document, so its other content (skills, mentions,
 * marks) survives: text nodes by exact token, and file-reference atoms whose path (or, for a typed
 * atom without one, whose token) names the expired host path exactly.
 */
function rewriteDocument(node: JSONContent, restored: ReadonlyMap<string, string>): JSONContent {
  if (node.type === FILE_REFERENCE_NODE && node.attrs) {
    const path = typeof node.attrs.path === 'string' ? node.attrs.path : ''
    const host =
      path !== ''
        ? path
        : [...restored.keys()].find(
            (key) => node.attrs?.token === formatNativeChatFileReference(key)
          )
    const original = host === undefined ? undefined : restored.get(host)
    return original
      ? {
          ...node,
          attrs: {
            ...node.attrs,
            token: formatNativeChatFileReference(original),
            path: path === '' ? '' : original
          }
        }
      : node
  }
  return {
    ...node,
    ...(node.text !== undefined ? { text: rewriteReferences(node.text, restored).text } : {}),
    ...(node.content
      ? { content: node.content.map((child) => rewriteDocument(child, restored)) }
      : {})
  }
}

/** A handoff's pending caret/selection survives the repair write, shifted past rewritten tokens. */
function carriedPosition(
  scope: string,
  offset: (at: number) => number
): NativeChatDraftPosition | undefined {
  const current = records.get(scope)
  const position = current && nativeChatDraftPositions.get(current)
  if (!position?.pending) {
    return undefined
  }
  return position.at === 'selection'
    ? { ...position, from: offset(position.from), to: offset(position.to) }
    : { ...position }
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
  const unresolvedText = referencedHosts(draft.text, [...note.text])
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
  const { text, offset } = rewriteReferences(draft.text, textRestored)
  updateNativeChatComposerDraft(
    scope,
    text === draft.text
      ? { images }
      : {
          images,
          text,
          document: draft.document && rewriteDocument(draft.document, textRestored)
        },
    'immediate',
    undefined,
    carriedPosition(scope, offset)
  )
}

/** The draft is gone for good: nothing will move into it to repair. */
export function forgetNativeChatUnrestoredExpiredUploads(scope: string): void {
  unrestored.delete(scope)
}
