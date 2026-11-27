import type { Processor } from 'unified'
import type { VFile } from 'vfile'
import { splitAtProseUrlTerminators } from './text/prose-url-boundary'

type MarkdownNode = {
  type: string
  value?: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MarkdownNode[]
}

const EMPHASIS_RUN = /^([*_])\1{0,2}$/

/** The text of a bare-url link written as itself, not `<url>` or `[url](url)`. */
function autolinkLiteralText(node: MarkdownNode): { text: string; start: number } | null {
  const [child, ...rest] = node.children ?? []
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (node.type !== 'link' || child?.type !== 'text' || rest.length > 0) {
    return null
  }
  if (child.value === undefined || start === undefined || end === undefined) {
    return null
  }
  return end - start === child.value.length ? { text: child.value, start } : null
}

function removePositions(node: MarkdownNode): void {
  delete node.position
  node.children?.forEach(removePositions)
}

// GFM paired emphasis while the uncut url still held its closing run, so pair it with the same run right before the url.
function emphasizeCutUrl(
  children: MarkdownNode[],
  split: MarkdownNode[],
  urlPiece: string,
  source: string,
  urlStart: number
): void {
  const previous = children.at(-1)
  const [link, closer] = split
  const run = closer?.type === 'text' ? closer.value : undefined
  if (link?.type !== 'link' || !run || !EMPHASIS_RUN.test(run) || !urlPiece.endsWith(run)) {
    return
  }
  if (previous?.type !== 'text') {
    return
  }
  const runStart = urlStart - run.length
  const before = source.slice(Math.max(0, runStart - 2), runStart)
  if (source.slice(runStart, urlStart) !== run || /[\\*_]$/.test(before)) {
    return
  }
  // A bare url starts alphanumeric, so the run opens; `_` cannot also follow a word character.
  if (run[0] === '_' && before && !/[\s\p{P}\p{S}]$/u.test(before)) {
    return
  }
  if (!previous.value?.endsWith(run)) {
    return
  }
  previous.value = previous.value.slice(0, -run.length)
  if (!previous.value) {
    children.pop()
  }
  const inner = run.length > 1 ? { type: 'strong', children: [link] } : link
  split.splice(0, 2, run.length % 2 === 1 ? { type: 'emphasis', children: [inner] } : inner)
}

// GFM stops bare URLs at whitespace and trims ASCII punctuation only; split prose punctuation so its own balanced-parenthesis rules exclude trailing )。 correctly.
export function remarkAutolinkLiteralProseBoundary(
  this: Processor
): (tree: MarkdownNode, file: VFile) => void {
  const parseInline = (text: string): MarkdownNode[] => {
    const tree: MarkdownNode = this.parse(text)
    const [paragraph] = tree.children ?? []
    if (paragraph?.type !== 'paragraph' || !paragraph.children) {
      return [{ type: 'text', value: text }]
    }
    paragraph.children.forEach(removePositions)
    return paragraph.children
  }

  const splitAutolinkLiterals = (node: MarkdownNode, source: string): void => {
    if (!node.children) {
      return
    }
    const children: MarkdownNode[] = []
    for (const child of node.children) {
      const literal = autolinkLiteralText(child)
      const pieces = literal ? splitAtProseUrlTerminators(literal.text) : []
      if (!literal || pieces.length < 2) {
        splitAutolinkLiterals(child, source)
        children.push(child)
        continue
      }
      const split = pieces.flatMap((piece, index) => {
        if (index % 2 === 1) {
          return [{ type: 'text', value: piece }]
        }
        return piece ? parseInline(piece) : []
      })
      emphasizeCutUrl(children, split, pieces[0], source, literal.start)
      children.push(...split)
    }
    node.children = children
  }

  return (tree, file) => splitAutolinkLiterals(tree, String(file))
}
