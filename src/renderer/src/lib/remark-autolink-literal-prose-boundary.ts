import type { Processor } from 'unified'
import { splitAtProseUrlTerminators } from '../../../shared/prose-url-boundary'

type MarkdownNode = {
  type: string
  value?: string
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

// GFM stops bare URLs at whitespace and trims ASCII punctuation only; split prose punctuation so its own balanced-parenthesis rules exclude trailing )。 correctly.
export function remarkAutolinkLiteralProseBoundary(this: Processor): (tree: MarkdownNode) => void {
  const parseInline = (text: string): MarkdownNode[] => {
    const tree: MarkdownNode = this.parse(text)
    const [paragraph] = tree.children ?? []
    if (paragraph?.type !== 'paragraph' || !paragraph.children) {
      return [{ type: 'text', value: text }]
    }
    paragraph.children.forEach(removePositions)
    return paragraph.children
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

  return splitAutolinkLiterals
}
