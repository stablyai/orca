import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

const segmenters = new Map<string, Intl.Segmenter>()

function leafText(node: ProseMirrorNode): string {
  return node.type.name === 'hardBreak' ? ' ' : (node.type.spec.leafText?.(node) ?? '')
}

/** ProseMirror textContent joins blocks and drops hard breaks; textBetween keeps both separated. */
export function wordCountText(doc: ProseMirrorNode, from: number, to: number): string {
  return doc.textBetween(from, to, ' ', leafText)
}

function segmenterFor(locale: string): Intl.Segmenter {
  let segmenter = segmenters.get(locale)
  if (!segmenter) {
    segmenter = new Intl.Segmenter(locale, { granularity: 'word' })
    segmenters.set(locale, segmenter)
  }
  return segmenter
}

/** Count word-like segments; whitespace splitting miscounts CJK and keeps punctuation. */
export function countWords(text: string, locale: string): number {
  let count = 0
  for (const { isWordLike } of segmenterFor(locale).segment(text)) {
    if (isWordLike) {
      count += 1
    }
  }
  return count
}
