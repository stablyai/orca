import type { VFile } from 'vfile'

type MarkdownNode = {
  type: string
  value?: string
  children?: MarkdownNode[]
}

export type HtmlRewriteObserver = (
  node: MarkdownNode,
  pieces: readonly (string | readonly [number, number])[]
) => void

declare module 'vfile' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- VFile metadata uses declaration merging.
  interface DataMap {
    markdownHtmlRewrite?: HtmlRewriteObserver
  }
}

const HTML_TAG_NAME_PATTERN =
  /<!--[\s\S]*?(?:-->|$)|<\/?([A-Za-z][A-Za-z0-9-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/g

const PHRASING_PARENT_TYPES = new Set([
  'paragraph',
  'heading',
  'emphasis',
  'strong',
  'delete',
  'link',
  'linkReference',
  'tableCell'
])

function isUnknownTag(name: string | undefined, allowedTagNames: ReadonlySet<string>): boolean {
  return name !== undefined && !allowedTagNames.has(name.toLowerCase())
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function classifyHtml(
  html: string,
  allowedTagNames: ReadonlySet<string>
): 'none' | 'unknown-only' | 'mixed' {
  let hasUnknown = false
  let hasOther = false
  for (const match of html.matchAll(HTML_TAG_NAME_PATTERN)) {
    if (isUnknownTag(match[1], allowedTagNames)) {
      hasUnknown = true
    } else {
      hasOther = true
    }
  }
  return hasUnknown ? (hasOther ? 'mixed' : 'unknown-only') : 'none'
}

/** Whether the transform replaces this whole HTML node with text, so no raw HTML reaches rendering. */
export function htmlRendersAsText(html: string, allowedTagNames: ReadonlySet<string>): boolean {
  return classifyHtml(html, allowedTagNames) === 'unknown-only'
}

function replaceUnknownHtml(
  parent: MarkdownNode,
  allowedTagNames: ReadonlySet<string>,
  onRewrite?: HtmlRewriteObserver
): void {
  const children = parent.children
  if (!children) {
    return
  }
  const isPhrasingParent = PHRASING_PARENT_TYPES.has(parent.type)
  for (let index = 0; index < children.length; index++) {
    const child = children[index]
    if (child.type !== 'html' || !child.value) {
      replaceUnknownHtml(child, allowedTagNames, onRewrite)
      continue
    }
    const kind = classifyHtml(child.value, allowedTagNames)
    if (kind === 'unknown-only') {
      const text: MarkdownNode = { type: 'text', value: child.value }
      children[index] = isPhrasingParent ? text : { type: 'paragraph', children: [text] }
    } else if (kind === 'mixed') {
      const pieces: (string | readonly [number, number])[] = []
      let copied = 0
      // Escape unknown tags only so allowed HTML/comments in mixed blocks retain their rendering.
      const output = child.value.replace(
        HTML_TAG_NAME_PATTERN,
        (match: string, name: string | undefined, offset: number) => {
          if (!isUnknownTag(name, allowedTagNames)) {
            return match
          }
          if (onRewrite) {
            pieces.push([copied, offset])
            let start = offset
            for (let index = 0; index < match.length; index++) {
              const character = match[index]!
              if (character !== '&' && character !== '<' && character !== '>') {
                continue
              }
              pieces.push([start, offset + index], escapeHtmlText(character))
              start = offset + index + 1
            }
            pieces.push([start, offset + match.length])
            copied = offset + match.length
          }
          return escapeHtmlText(match)
        }
      )
      if (onRewrite) {
        pieces.push([copied, child.value.length])
        onRewrite(child, pieces)
      }
      child.value = output
    }
  }
}

/** Render unsupported tags literally so sanitize cannot erase tag-shaped prose. */
export function remarkUnknownHtmlAsText(
  allowedTagNames: ReadonlySet<string>,
  onRewrite?: HtmlRewriteObserver
): () => (tree: MarkdownNode, file: VFile) => void {
  return () => (tree, file) =>
    replaceUnknownHtml(tree, allowedTagNames, onRewrite ?? file.data.markdownHtmlRewrite)
}
