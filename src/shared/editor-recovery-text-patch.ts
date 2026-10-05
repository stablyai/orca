import { z } from 'zod'

export const editorRecoveryTextPatchSchema = z
  .object({
    baseLength: z.number().int().nonnegative(),
    start: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    inserted: z.string(),
    byteLengthDelta: z.number().int()
  })
  .refine(
    (patch) => patch.start <= patch.baseLength && patch.removed <= patch.baseLength - patch.start
  )
export type EditorRecoveryTextPatch = z.infer<typeof editorRecoveryTextPatchSchema>

const CHUNK_LENGTH = 16_384
const encoder = new TextEncoder()
const highSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const lowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/** Diff only at checkpoint time; small drafts and large replacements use a full snapshot. */
export function createEditorRecoveryTextPatch(
  previous: string,
  content: string
): EditorRecoveryTextPatch | null {
  if (content.length < 4_096 || content.length < previous.length / 2) {
    return null
  }
  if (previous === content) {
    return {
      baseLength: previous.length,
      start: previous.length,
      removed: 0,
      inserted: '',
      byteLengthDelta: 0
    }
  }
  const limit = Math.min(previous.length, content.length)
  let start = 0
  let suffix = 0
  while (
    start + CHUNK_LENGTH <= limit &&
    previous.slice(start, start + CHUNK_LENGTH) === content.slice(start, start + CHUNK_LENGTH)
  ) {
    start += CHUNK_LENGTH
  }
  while (start < limit && previous.charCodeAt(start) === content.charCodeAt(start)) {
    start++
  }
  while (
    suffix + CHUNK_LENGTH <= limit - start &&
    previous.slice(previous.length - suffix - CHUNK_LENGTH, previous.length - suffix) ===
      content.slice(content.length - suffix - CHUNK_LENGTH, content.length - suffix)
  ) {
    suffix += CHUNK_LENGTH
  }
  while (
    suffix < limit - start &&
    previous.charCodeAt(previous.length - suffix - 1) ===
      content.charCodeAt(content.length - suffix - 1)
  ) {
    suffix++
  }
  // Include a whole surrogate pair when measuring the UTF-8 size of either edited segment.
  if (
    start > 0 &&
    highSurrogate(previous.charCodeAt(start - 1)) &&
    (lowSurrogate(previous.charCodeAt(start)) || lowSurrogate(content.charCodeAt(start)))
  ) {
    start--
  }
  if (
    suffix > 0 &&
    lowSurrogate(previous.charCodeAt(previous.length - suffix)) &&
    (highSurrogate(previous.charCodeAt(previous.length - suffix - 1)) ||
      highSurrogate(content.charCodeAt(content.length - suffix - 1)))
  ) {
    suffix--
  }
  const inserted = content.slice(start, content.length - suffix)
  const removed = previous.length - start - suffix
  if (inserted.length > content.length / 2 || removed > previous.length / 2) {
    return null
  }
  return {
    baseLength: previous.length,
    start,
    removed,
    inserted,
    byteLengthDelta:
      encoder.encode(inserted).length -
      encoder.encode(previous.slice(start, start + removed)).length
  }
}

/** Keep slices until the final join rather than copying the whole body once per patch. */
export function replayEditorRecoveryTextPatches(
  content: string,
  patches: readonly EditorRecoveryTextPatch[]
): string {
  let parts = [content]
  let length = content.length
  for (const patch of patches) {
    if (
      patch.baseLength !== length ||
      patch.start > length ||
      patch.removed > length - patch.start
    ) {
      throw new Error('Recovery patch does not match its saved text')
    }
    const before: string[] = []
    const after: string[] = []
    const end = patch.start + patch.removed
    let offset = 0
    for (const part of parts) {
      if (offset < patch.start) {
        before.push(part.slice(0, Math.min(part.length, patch.start - offset)))
      }
      if (offset + part.length > end) {
        after.push(part.slice(Math.max(0, end - offset)))
      }
      offset += part.length
    }
    parts = [...before, patch.inserted, ...after].filter((part) => part.length > 0)
    length += patch.inserted.length - patch.removed
  }
  return parts.join('')
}
