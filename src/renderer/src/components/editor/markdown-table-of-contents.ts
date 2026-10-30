import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { MarkdownHeadingSlugger } from './markdown-heading-slug'

export type MarkdownTocLevel = 1 | 2 | 3 | 4 | 5

export type MarkdownTocItem = {
  children: MarkdownTocItem[]
  id: string
  level: MarkdownTocLevel
  title: string
}

const htmlEntitiesForToc = new Map([
  ['amp', '&'],
  ['apos', "'"],
  ['gt', '>'],
  ['lt', '<'],
  ['nbsp', ' '],
  ['quot', '"']
])

function isMarkdownTocLevel(value: number): value is MarkdownTocLevel {
  return value >= 1 && value <= 5
}

// Use the needed entities@6.0.1 behavior locally: TOC labels need common/numeric decoding without the full entity database.
function decodeTocHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase()
    if (normalized.startsWith('#x')) {
      const codePoint = Number.parseInt(normalized.slice(2), 16)
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match
    }
    if (normalized.startsWith('#')) {
      const codePoint = Number.parseInt(normalized.slice(1), 10)
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match
    }
    return htmlEntitiesForToc.get(normalized) ?? match
  })
}

export function stripInlineMarkdownForToc(text: string): string {
  const stripped = decodeTocHtmlEntities(text)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\[[^|\]]+\|([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~]/g, '')
  return normalizeMarkdownTocTitle(stripped)
}

// Collapse display whitespace without another full-string regex pass over large pasted headings.
export function normalizeMarkdownTocTitle(value: string): string {
  let normalized = ''
  let pendingWhitespace = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (isMarkdownTocWhitespace(code)) {
      pendingWhitespace = normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += ' '
      pendingWhitespace = false
    }
    normalized += value.charAt(index)
  }
  return normalized
}

function isMarkdownTocWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

function nearestParent(stack: MarkdownTocItem[], level: MarkdownTocLevel): MarkdownTocItem {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const item = stack.at(index)
    if (item && item.level < level) {
      return item
    }
  }
  return stack[0]
}

function appendTocItem(stack: MarkdownTocItem[], item: MarkdownTocItem): void {
  nearestParent(stack, item.level).children.push(item)
  Reflect.set(stack, item.level, item)
  stack.length = item.level + 1
}

type MarkdownAstNode = {
  alt?: string | null
  children?: MarkdownAstNode[]
  depth?: number
  type?: string
  value?: string
}

// Keep the heading-only mdast-util-to-string@4.0.0 behavior locally to avoid the broader dependency.
function markdownAstNodeToText(node: MarkdownAstNode): string {
  if (typeof node.value === 'string') {
    return node.value
  }
  if (typeof node.alt === 'string') {
    return node.alt
  }
  return (node.children ?? []).map(markdownAstNodeToText).join('')
}

export function buildMarkdownTableOfContents(markdown: string): MarkdownTocItem[] {
  const slugger = new MarkdownHeadingSlugger()
  const root = { id: 'toc-root', level: 1 as const, title: '', children: [] }
  const stack: MarkdownTocItem[] = [root]

  // Use the parser so TOC headings match rendered setext/GFM/entity behavior.
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkCjkFriendly)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .parse(markdown)

  function visit(node: MarkdownAstNode): void {
    if (
      node.type === 'heading' &&
      typeof node.depth === 'number' &&
      isMarkdownTocLevel(node.depth)
    ) {
      const title = normalizeMarkdownTocTitle(markdownAstNodeToText(node))
      if (title) {
        appendTocItem(stack, {
          children: [],
          id: slugger.slug(title),
          level: node.depth,
          title
        })
      }
    }
    for (const child of node.children ?? []) {
      visit(child)
    }
  }

  visit(tree)

  return root.children
}
