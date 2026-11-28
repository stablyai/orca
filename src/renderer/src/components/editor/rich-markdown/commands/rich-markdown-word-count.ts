import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

const segmenters = new Map<string, Intl.Segmenter>()

function leafText(node: ProseMirrorNode): string {
  return node.type.name === 'hardBreak' ? ' ' : (node.type.spec.leafText?.(node) ?? '')
}

/** ProseMirror textContent joins blocks and drops hard breaks; textBetween keeps both separated. */
export function wordCountText(doc: ProseMirrorNode, from: number, to: number): string {
  return doc.textBetween(from, to, ' ', leafText)
}

type WordCountSelection = {
  empty: boolean
  ranges: readonly { $from: { pos: number }; $to: { pos: number } }[]
}

/** CellSelection holds one range per cell; from/to alone describe only the head cell. */
export function wordCountTextForSelection(
  doc: ProseMirrorNode,
  selection: WordCountSelection
): string {
  if (selection.empty) {
    return wordCountText(doc, 0, doc.content.size)
  }
  return selection.ranges.map(({ $from, $to }) => wordCountText(doc, $from.pos, $to.pos)).join('\n')
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
