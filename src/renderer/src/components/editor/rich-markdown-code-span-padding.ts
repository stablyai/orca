import { Extension } from '@tiptap/core'

type MarkdownNodeLike = {
  type?: string
  text?: string
  marks?: (string | { type?: string })[]
}

type BoundaryWalk = (nodes: MarkdownNodeLike[], ...rest: unknown[]) => unknown

type MarkdownManager = {
  renderNodesWithMarkBoundaries?: BoundaryWalk
}

function isMarkdownManager(value: unknown): value is MarkdownManager {
  return typeof value === 'object' && value !== null
}

function hasCodeMark(node: MarkdownNodeLike): boolean {
  return (node.marks ?? []).some(
    (mark) => (typeof mark === 'string' ? mark : mark?.type) === 'code'
  )
}

/**
 * Swaps a code span's leading and trailing spaces for a placeholder. The walk
 * strips whitespace off a marked run and re-appends it outside the delimiters,
 * which is right for emphasis (`** text **` is not emphasis) and wrong for a code
 * span, where CommonMark strips one pad on render and the source keeps its bytes.
 */
function paddingPlaceholder(nodes: MarkdownNodeLike[]): string {
  const source = JSON.stringify(nodes)
  let placeholder = '\uE000'
  while (source.includes(placeholder)) {
    placeholder += '\uE000'
  }
  return placeholder
}

export function maskCodeSpanPadding(nodes: MarkdownNodeLike[]): {
  nodes: MarkdownNodeLike[]
  placeholder: string
  replacements: readonly (readonly [string, string])[]
} {
  const placeholder = paddingPlaceholder(nodes)
  const replacements: [string, string][] = []
  const mask = (padding: string): string => {
    const token = `${placeholder}${replacements.length}${placeholder}`
    replacements.push([token, padding])
    return token
  }
  const masked = nodes.map((node) => {
    if (node?.type !== 'text' || !hasCodeMark(node)) {
      return node
    }
    const text = node.text ?? ''
    const leading = text.match(/^(\s+)/)?.[1] ?? ''
    const trailing = text.slice(leading.length).match(/(\s+)$/)?.[1] ?? ''
    if (!leading && !trailing) {
      return node
    }
    const body = text.slice(leading.length, trailing ? text.length - trailing.length : text.length)
    return {
      ...node,
      text: (leading ? mask(leading) : '') + body + (trailing ? mask(trailing) : '')
    }
  })
  return { nodes: masked, placeholder, replacements }
}

export function restoreCodeSpanPadding(
  markdown: string,
  placeholder: string,
  replacements: readonly (readonly [string, string])[]
): string {
  const padding = new Map(replacements)
  return markdown.replace(
    new RegExp(`${placeholder}\\d+${placeholder}`, 'g'),
    (token) => padding.get(token) ?? token
  )
}

/**
 * Keeps a code span's padding inside its backticks. Registered at the lowest
 * priority so it runs after `Markdown` publishes the manager on the editor.
 */
export const RichMarkdownCodeSpanPadding = Extension.create({
  name: 'richMarkdownCodeSpanPadding',
  priority: 1,

  onBeforeCreate() {
    const managerValue: unknown = this.editor.markdown
    if (!isMarkdownManager(managerValue)) {
      return
    }
    const prototypeValue: unknown = Object.getPrototypeOf(managerValue)
    const prototype = isMarkdownManager(prototypeValue) ? prototypeValue : undefined
    const walk = prototype?.renderNodesWithMarkBoundaries
    if (typeof walk !== 'function') {
      return
    }
    managerValue.renderNodesWithMarkBoundaries = function (
      this: unknown,
      nodes: MarkdownNodeLike[],
      ...rest: unknown[]
    ) {
      const masked = maskCodeSpanPadding(nodes ?? [])
      const rendered = walk.call(this, masked.nodes, ...rest)
      return typeof rendered === 'string'
        ? restoreCodeSpanPadding(rendered, masked.placeholder, masked.replacements)
        : rendered
    }
  }
})
