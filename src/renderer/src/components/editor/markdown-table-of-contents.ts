import GithubSlugger from 'github-slugger'
import { decodeHTML } from 'entities'
import { toString } from 'mdast-util-to-string'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export type MarkdownTocLevel = 1 | 2 | 3

export type MarkdownTocItem = {
  children: MarkdownTocItem[]
  id: string
  level: MarkdownTocLevel
  title: string
}

function isMarkdownTocLevel(value: number): value is MarkdownTocLevel {
  return value === 1 || value === 2 || value === 3
}

export function stripInlineMarkdownForToc(text: string): string {
  return decodeHTML(text)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\[[^|\]]+\|([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
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
  children?: MarkdownAstNode[]
  depth?: number
  type?: string
}

export function buildMarkdownTableOfContents(markdown: string): MarkdownTocItem[] {
  const slugger = new GithubSlugger()
  const root: MarkdownTocItem = { id: 'toc-root', level: 1, title: '', children: [] }
  const stack: MarkdownTocItem[] = [root]

  // Why: the TOC must produce the same heading text/ids as react-markdown plus
  // rehype-slug; parsing Markdown avoids drift on setext, GFM, and entities.
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
      const title = toString(node).replace(/\s+/g, ' ').trim()
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
