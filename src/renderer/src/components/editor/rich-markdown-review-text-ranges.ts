import type { Editor } from '@tiptap/react'
import type { RichMarkdownAnnotationHighlightRange } from './rich-markdown-annotation-highlight'

type RichMarkdownTextChar = {
  value: string
  pos: number | null
}

function normalizeRichMarkdownTextWithPositions(
  chars: RichMarkdownTextChar[]
): RichMarkdownTextChar[] {
  const normalized: RichMarkdownTextChar[] = []
  let previousWasWhitespace = false
  for (const char of chars) {
    if (/\s/.test(char.value)) {
      if (!previousWasWhitespace) {
        normalized.push({ value: ' ', pos: char.pos })
      }
      previousWasWhitespace = true
      continue
    }
    normalized.push(char)
    previousWasWhitespace = false
  }
  return normalized
}

function collectRichMarkdownTextChars(
  editor: Editor,
  from = 0,
  to = editor.state.doc.content.size
): RichMarkdownTextChar[] {
  const chars: RichMarkdownTextChar[] = []
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText || !node.text) {
      return
    }
    if (chars.length > 0) {
      chars.push({ value: ' ', pos: null })
    }
    for (let index = 0; index < node.text.length; index += 1) {
      chars.push({ value: node.text[index], pos: pos + index })
    }
  })
  return chars
}

export function findRichMarkdownSelectedTextRanges({
  editor,
  selectedText,
  from,
  to
}: {
  editor: Editor
  selectedText: string
  from?: number
  to?: number
}): RichMarkdownAnnotationHighlightRange[] {
  const normalizedChars = normalizeRichMarkdownTextWithPositions(
    collectRichMarkdownTextChars(editor, from, to)
  )
  const haystack = normalizedChars.map((char) => char.value).join('')
  const needle = normalizeRichMarkdownTextWithPositions(
    Array.from(selectedText).map((value) => ({ value, pos: null }))
  )
    .map((char) => char.value)
    .join('')
  const start = haystack.indexOf(needle)
  if (start === -1) {
    return []
  }

  const positions = normalizedChars
    .slice(start, start + needle.length)
    .map((char) => char.pos)
    .filter((pos): pos is number => pos !== null)
    .sort((left, right) => left - right)
  if (positions.length === 0) {
    return []
  }

  const ranges: RichMarkdownAnnotationHighlightRange[] = []
  let rangeFrom = positions[0]
  let rangeTo = positions[0] + 1
  for (const pos of positions.slice(1)) {
    if (pos === rangeTo) {
      rangeTo += 1
      continue
    }
    ranges.push({ from: rangeFrom, to: rangeTo })
    rangeFrom = pos
    rangeTo = pos + 1
  }
  ranges.push({ from: rangeFrom, to: rangeTo })
  return ranges
}
