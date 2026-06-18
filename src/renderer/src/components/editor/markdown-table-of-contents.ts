import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { MarkdownHeadingSlugger } from './markdown-heading-slug'

export type MarkdownTocLevel = 1 | 2 | 3

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
  return value === 1 || value === 2 || value === 3
}

// Scoped local fork of the tiny entities@6.0.1 surface Orca used here.
// Why: TOC labels only need common/numeric entity decoding before inline
// Markdown stripping, not the full entity database.
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
  return foldMarkdownTocWhitespace(stripped)
}

// Why: headings can come from large pasted markdown; TOC labels only need
// collapsed display whitespace, not a whole-string whitespace regex pass.
function foldMarkdownTocWhitespace(value: string): string {
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
  alt?: string
  children?: MarkdownAstNode[]
  depth?: number
  type?: string
  value?: string
}

// Scoped local fork of mdast-util-to-string@4.0.0 for heading nodes.
// Why: TOC generation only needs text/alt/child concatenation from parsed
// Markdown headings, so a local walker keeps the dependency boundary smaller.
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

  // Why: parsing Markdown keeps the TOC aligned with rendered setext/GFM/entity
  // headings without carrying separate mdast stringifier/entity packages.
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .parse(markdown) as MarkdownAstNode

  function visit(node: MarkdownAstNode): void {
    if (
      node.type === 'heading' &&
      typeof node.depth === 'number' &&
      isMarkdownTocLevel(node.depth)
    ) {
      const title = foldMarkdownTocWhitespace(markdownAstNodeToText(node))
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
