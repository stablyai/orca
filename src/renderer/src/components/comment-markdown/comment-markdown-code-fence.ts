import { createContext } from 'react'
import type { Extension } from 'mdast-util-from-markdown'
import type { Position } from 'unist'
import type { Processor } from 'unified'

export const MARKDOWN_CLOSING_FENCE = 'dataMarkdownClosingFence'

type MarkdownBlockSource = {
  authored: string
  drawn: string
}

export const CommentMarkdownBlockSourceContext = createContext<MarkdownBlockSource | null>(null)

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

export function isConfirmedClosingFence(
  source: MarkdownBlockSource,
  position: Position | undefined
): boolean {
  if (position?.start.offset === undefined || position.end.offset === undefined) {
    return false
  }

  // Micromark drops an initial BOM before assigning offsets.
  const bomLength = Number(source.drawn.startsWith('\uFEFF'))
  const marker = source.drawn[position.start.offset + bomLength]
  if (marker !== '`' && marker !== '~') {
    return false
  }
  const drawnEnd = position.end.offset + bomLength
  if (source.authored === source.drawn) {
    return source.authored[drawnEnd] === '\n' || source.authored[drawnEnd] === '\r'
  }

  // Streaming Markdown repairs can change offsets or trim the break after the authored closer.
  const trimSpacing = /[ \t]+$/
  const drawnStart = drawnEnd - position.end.column + 1
  const line = source.drawn.slice(drawnStart, drawnEnd).replace(trimSpacing, '')
  let authoredStart = Number(source.authored.startsWith('\uFEFF'))
  let lineNumber = 1
  for (const lineBreak of source.authored.matchAll(/\r\n?|\n/g)) {
    if (lineNumber === position.end.line) {
      return source.authored.slice(authoredStart, lineBreak.index).replace(trimSpacing, '') === line
    }
    authoredStart = lineBreak.index + lineBreak[0].length
    lineNumber += 1
  }
  return false
}
