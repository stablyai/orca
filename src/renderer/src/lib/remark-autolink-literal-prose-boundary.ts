import type { Processor } from 'unified'
import { splitAtProseUrlTerminators } from '../../../shared/prose-url-boundary'

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MarkdownNode[]
}

type SourceEdit = { start: number; end: number; text: string }

type AutolinkLiteral = { text: string; start: number; end: number }

/** A bare-url link written as itself, not `<url>` or `[url](url)`, with its source span. */
function autolinkLiteral(node: MarkdownNode): AutolinkLiteral | null {
  const [child, ...rest] = node.children ?? []
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (node.type !== 'link' || child?.type !== 'text' || rest.length > 0) {
    return null
  }
  if (child.value === undefined || start === undefined || end === undefined) {
    return null
  }
  return end - start === child.value.length ? { text: child.value, start, end } : null
}

function autolinkLiteralText(node: MarkdownNode): string | null {
  return autolinkLiteral(node)?.text ?? null
}

function removePositions(node: MarkdownNode): void {
  delete node.position
  node.children?.forEach(removePositions)
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g

const EMPHASIS_DELIMITER = /[*_~]/

/** `piece` with the bare url it starts with written as an explicit link, or null when
 *  GFM trimmed no emphasis delimiter (`**`, `_`) off the url that could close a pair. */
function explicitLinkSource(piece: string, leading: MarkdownNode | undefined): string | null {
  const text = leading ? autolinkLiteralText(leading) : null
  if (!leading || text === null || leading.url === undefined || !piece.startsWith(text)) {
    return null
  }
  const rest = piece.slice(text.length)
  if (!EMPHASIS_DELIMITER.test(rest)) {
    return null
  }
  return `[${text.replace(ASCII_PUNCTUATION, '\\$&')}](<${leading.url}>)${rest}`
}

// Why: GFM ends a bare url only at whitespace and trims only ASCII punctuation, so the url
// in `(https://…/1078)。` kept `)。`; parsing each piece between prose punctuation lets GFM's
// own trim and balanced-paren rule run on just the url.
export function remarkAutolinkLiteralProseBoundary(
  this: Processor
): (tree: MarkdownNode, file: { value?: unknown }) => MarkdownNode | undefined {
  const parsePieceTree = (text: string): MarkdownNode[] | null => {
    const tree: MarkdownNode = this.parse(text)
    const [paragraph] = tree.children ?? []
    return paragraph?.type === 'paragraph' && paragraph.children ? paragraph.children : null
  }

  const parseInline = (text: string): MarkdownNode[] => {
    const children = parsePieceTree(text)
    if (!children) {
      return [{ type: 'text', value: text }]
    }
    children.forEach(removePositions)
    return children
  }

  const splitAutolinkLiterals = (node: MarkdownNode): void => {
    if (!node.children) {
      return
    }
    node.children = node.children.flatMap((child) => {
      const literal = autolinkLiteralText(child)
      const pieces = literal === null ? [] : splitAtProseUrlTerminators(literal)
      if (pieces.length < 2) {
        splitAutolinkLiterals(child)
        return [child]
      }
      return pieces.flatMap((piece, index) => {
        if (index % 2 === 1) {
          return [{ type: 'text', value: piece }]
        }
        return piece ? parseInline(piece) : []
      })
    })
  }

  const collectEdits = (node: MarkdownNode, edits: SourceEdit[]): void => {
    for (const child of node.children ?? []) {
      const literal = autolinkLiteral(child)
      const pieces = literal === null ? [] : splitAtProseUrlTerminators(literal.text)
      if (literal === null || pieces.length < 2) {
        collectEdits(child, edits)
        continue
      }
      let changed = false
      const text = pieces
        .map((piece, index) => {
          if (index % 2 === 1 || !piece) {
            return piece
          }
          const explicit = explicitLinkSource(piece, parsePieceTree(piece)?.[0])
          changed ||= explicit !== null
          return explicit ?? piece
        })
        .join('')
      if (changed) {
        edits.push({ start: literal.start, end: literal.end, text })
      }
    }
  }

  return (tree, file) => {
    // Why: emphasis is paired before this runs, so `**url**（…` already lost its closing
    // `**` to the url. Reparsing with that url made explicit lets the pair close; lines
    // keep their numbers, so preview scroll sync still maps blocks to the source.
    const edits: SourceEdit[] = []
    collectEdits(tree, edits)
    if (edits.length > 0 && typeof file.value === 'string') {
      let source = file.value
      for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
        source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
      }
      const reparsed: MarkdownNode = this.parse(source)
      splitAutolinkLiterals(reparsed)
      return reparsed
    }
    splitAutolinkLiterals(tree)
    return undefined
  }
}
