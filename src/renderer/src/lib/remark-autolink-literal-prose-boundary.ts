import type { Processor } from 'unified'
import { splitAtProseUrlTerminators } from '../../../shared/prose-url-boundary'

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MarkdownNode[]
}

/** The text of a bare-url link written as itself, not `<url>` or `[url](url)`. */
function autolinkLiteralText(node: MarkdownNode): string | null {
  const [child, ...rest] = node.children ?? []
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (node.type !== 'link' || child?.type !== 'text' || rest.length > 0) {
    return null
  }
  if (child.value === undefined || start === undefined || end === undefined) {
    return null
  }
  return end - start === child.value.length ? child.value : null
}

function removePositions(node: MarkdownNode): void {
  delete node.position
  node.children?.forEach(removePositions)
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g

/** A uniform `*` or `_` run that GFM trimmed off a bare url. */
function emphasisMarker(value: string): string | null {
  return /^([*_])\1{0,2}$/.test(value) ? value : null
}

function canOpenEmphasis(text: string, marker: string): boolean {
  if (!text.endsWith(marker)) {
    return false
  }
  const before = text.slice(0, -marker.length)
  return before.length === 0 || !/[A-Za-z0-9]$/.test(before)
}

// GFM stops bare URLs at whitespace and trims ASCII punctuation only; split prose punctuation so its own balanced-parenthesis rules exclude trailing )。 correctly.
export function remarkAutolinkLiteralProseBoundary(this: Processor): (tree: MarkdownNode) => void {
  const parsePieceTree = (text: string): MarkdownNode[] | null => {
    const tree: MarkdownNode = this.parse(text)
    const [paragraph] = tree.children ?? []
    if (paragraph?.type !== 'paragraph' || !paragraph.children) {
      return null
    }
    return paragraph.children
  }

  const parseInline = (text: string): MarkdownNode[] => {
    const children = parsePieceTree(text)
    if (!children) {
      return [{ type: 'text', value: text }]
    }
    children.forEach(removePositions)
    return children
  }

  // The url piece still holds the closing marker (`**`, `_`). GFM only trims it when that
  // piece is parsed alone, which is too late for the opener in the previous text.
  const trimmedEmphasis = (
    piece: string
  ): { text: string; url: string; marker: string } | null => {
    const children = parsePieceTree(piece)
    if (!children || children.length !== 2) {
      return null
    }
    const [leading, trailing] = children
    const text = leading ? autolinkLiteralText(leading) : null
    const marker = trailing?.type === 'text' ? emphasisMarker(trailing.value ?? '') : null
    if (!leading?.url || text === null || marker === null || !piece.startsWith(text)) {
      return null
    }
    if (piece.slice(text.length) !== marker || /[\s<>]/.test(leading.url)) {
      return null
    }
    return { text, url: leading.url, marker }
  }

  const splitPieces = (pieces: string[]): MarkdownNode[] =>
    pieces.flatMap((piece, index) => {
      if (index % 2 === 1) {
        return [{ type: 'text', value: piece }]
      }
      return piece ? parseInline(piece) : []
    })

  const splitAutolinkLiterals = (node: MarkdownNode): void => {
    if (!node.children) {
      return
    }
    const next: MarkdownNode[] = []
    for (const child of node.children) {
      const literal = autolinkLiteralText(child)
      const pieces = literal === null ? [] : splitAtProseUrlTerminators(literal)
      const emphasis = pieces.length < 2 ? null : trimmedEmphasis(pieces[0] ?? '')
      const previous = next.at(-1)
      if (
        literal !== null &&
        emphasis &&
        previous?.type === 'text' &&
        previous.value !== undefined &&
        canOpenEmphasis(previous.value, emphasis.marker)
      ) {
        const label = emphasis.text.replace(ASCII_PUNCTUATION, '\\$&')
        const explicit = [
          emphasis.marker,
          `[${label}](<${emphasis.url}>)`,
          emphasis.marker,
          pieces.slice(1).join('')
        ].join('')
        const reparsed = parseInline(explicit)
        const wrapped = reparsed.some(
          (part) => part.type === 'strong' || part.type === 'emphasis'
        )
        if (wrapped) {
          const remain = previous.value.slice(0, -emphasis.marker.length)
          if (remain) {
            previous.value = remain
          } else {
            next.pop()
          }
          next.push(...reparsed)
          continue
        }
      }
      if (pieces.length < 2) {
        splitAutolinkLiterals(child)
        next.push(child)
        continue
      }
      next.push(...splitPieces(pieces))
    }
    node.children = next
  }

  return splitAutolinkLiterals
}
