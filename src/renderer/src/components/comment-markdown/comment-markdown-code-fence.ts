import { createContext } from 'react'
import type { Extension } from 'mdast-util-from-markdown'
import type { Position } from 'unist'
import type { Processor } from 'unified'

export const MARKDOWN_CLOSING_FENCE = 'dataMarkdownClosingFence'

type ClosingFenceCheck = (position: Position | undefined) => boolean

export const CommentMarkdownClosingFenceContext = createContext<ClosingFenceCheck | null>(null)

const closingFenceTokens: Extension = {
  exit: {
    codeFencedFenceSequence() {
      // While reading the closing fence, the code body is still buffered in a fragment.
      const node = this.stack.at(-1)?.type === 'fragment' ? this.stack.at(-2) : undefined
      if (node?.type === 'code' && node.lang && /^html(?:\s|$)/i.test(node.lang)) {
        node.data ??= {}
        node.data.hProperties = { [MARKDOWN_CLOSING_FENCE]: 'true' }
      }
    }
  }
}

export function remarkMarkdownClosingFence(this: Processor): void {
  const data = this.data()
  data.fromMarkdownExtensions = [...(data.fromMarkdownExtensions ?? []), closingFenceTokens]
}

function endWithoutTrailingSpacing(text: string, start: number, end: number): number {
  while (end > start) {
    const code = text.charCodeAt(end - 1)
    if (code !== 0x20 && code !== 0x09) {
      break
    }
    end--
  }
  return end
}

export function createClosingFenceCheck(authored: string, drawn: string): ClosingFenceCheck {
  // Micromark drops an initial BOM before assigning offsets.
  const drawnBomLength = Number(drawn.startsWith('\uFEFF'))
  let unchanged: boolean | undefined
  let lineEnds: number[] | undefined
  let lineBreaks: ReturnType<string['matchAll']> | undefined
  return (position) => {
    if (position?.start.offset === undefined || position.end.offset === undefined) {
      return false
    }
    const marker = drawn[position.start.offset + drawnBomLength]
    if (marker !== '`' && marker !== '~') {
      return false
    }

    const drawnEnd = position.end.offset + drawnBomLength
    unchanged ??= authored === drawn
    if (unchanged) {
      return authored[drawnEnd] === '\n' || authored[drawnEnd] === '\r'
    }

    // Repairs can change offsets or trim a break. Share one forward scan across this block.
    lineEnds ??= []
    lineBreaks ??= authored.matchAll(/\r\n?|\n/g)
    const line = position.end.line
    while (lineEnds.length < line) {
      const match = lineBreaks.next()
      if (match.done) {
        return false
      }
      lineEnds.push(match.value.index)
    }
    const authoredEnd = lineEnds[line - 1]
    const previousEnd = lineEnds[line - 2]
    const authoredStart =
      previousEnd === undefined
        ? Number(authored.startsWith('\uFEFF'))
        : previousEnd + (authored.startsWith('\r\n', previousEnd) ? 2 : 1)
    const drawnStart = drawnEnd - position.end.column + 1
    const authoredContentEnd = endWithoutTrailingSpacing(authored, authoredStart, authoredEnd)
    const drawnContentEnd = endWithoutTrailingSpacing(drawn, drawnStart, drawnEnd)
    return (
      authored.slice(authoredStart, authoredContentEnd) === drawn.slice(drawnStart, drawnContentEnd)
    )
  }
}
