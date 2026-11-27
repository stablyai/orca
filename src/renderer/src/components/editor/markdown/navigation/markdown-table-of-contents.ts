import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { default as MarkdownHeadingSlugger } from 'github-slugger'
import { normalizeMarkdownTocTitle, stripInlineMarkdownForToc } from './markdown-toc-text'

export { normalizeMarkdownTocTitle, stripInlineMarkdownForToc }

export type MarkdownTocLevel = 1 | 2 | 3 | 4 | 5

export type MarkdownTocItem = {
  children: MarkdownTocItem[]
  id: string
  level: MarkdownTocLevel
  title: string
}

function isMarkdownTocLevel(value: number): value is MarkdownTocLevel {
  return value >= 1 && value <= 5
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
