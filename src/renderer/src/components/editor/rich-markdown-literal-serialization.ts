import type { Editor, JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import type { RichMarkdownEditorCodec } from './rich-markdown-source-transport'

const DOLLAR_SKIP_TYPES = new Set(['inlineMath', 'rawMarkdownHtmlInline'])

const CHEAP_NEEDS_WORK = /\$|\||\\[[\]]|^( {0,3})(#|-|\d+\.)( |$)/m
const REF_DEF = /^ {0,3}\[[^\n]*\]:/m

type BlockInfo = { block: ProseMirrorNode; inTableCell: boolean }
type CacheEntry = {
  markdown: string
  inTableCell: boolean
  hasRefDefs: boolean
  result: string
}

function dropOptionalEscapes(markdown: string, includeUnderscore: boolean): string {
  return markdown.replace(
    includeUnderscore ? /\\([\\_[\]])/g : /\\([\\[\]])/g,
    (escaped, character: string) => (character === '\\' ? escaped : character)
  )
}

function withoutOptionalEscapes(markdown: string): string {
  return dropOptionalEscapes(markdown, false)
}

function escapeBare(markdown: string, chars: string): string {
  const parts: string[] = []
  let oddBackslash = false
  for (let i = 0; i < markdown.length; i += 1) {
    const character = markdown[i] ?? ''
    const bare = !oddBackslash
    oddBackslash = character === '\\' ? !oddBackslash : false
    parts.push(chars.includes(character) && bare ? `\\${character}` : character)
  }
  return parts.join('')
}

function hasBare(markdown: string, chars: string): boolean {
  let oddBackslash = false
  for (let i = 0; i < markdown.length; i += 1) {
    const character = markdown[i] ?? ''
    const bare = !oddBackslash
    oddBackslash = character === '\\' ? !oddBackslash : false
    if (chars.includes(character) && bare) {
      return true
    }
  }
  return false
}

function destNeedsEscape(dest: string): boolean {
  let depth = 0
  let oddBackslash = false
  for (let i = 0; i < dest.length; i += 1) {
    const character = dest[i]
    const bare = !oddBackslash
    oddBackslash = character === '\\' ? !oddBackslash : false
    if (!bare) {
      continue
    }
    if (character === '(') {
      depth += 1
    } else if (character === ')') {
      if (depth === 0) {
        return true
      }
      depth -= 1
    }
  }
  return depth > 0
}

function escapeLineLeading(markdown: string): string {
  // Empty `1.` / `-` markers stay unescaped: commitEmptyOrderedListMarkerAsText
  // writes paragraph text "1." and tests assert getMarkdown() === '1.\n\n'.
  return markdown
    .replace(/^( {0,3})#(?= |$)/gm, '$1\\#')
    .replace(/^( {0,3})-(?= )/gm, '$1\\-')
    .replace(/^( {0,3})(\d+)\.(?= )/gm, '$1$2\\.')
}

function escapeBareDollarsSkippingCode(markdown: string): string {
  const parts: string[] = []
  let i = 0
  let oddBackslash = false
  while (i < markdown.length) {
    if (markdown[i] === '`' && !oddBackslash) {
      let run = 0
      while (i + run < markdown.length && markdown[i + run] === '`') {
        run += 1
      }
      let cursor = i + run
      let closeAt = -1
      while (cursor < markdown.length) {
        if (markdown[cursor] !== '`') {
          cursor += 1
          continue
        }
        let close = 0
        while (cursor + close < markdown.length && markdown[cursor + close] === '`') {
          close += 1
        }
        if (close === run) {
          closeAt = cursor + close
          break
        }
        cursor += close
      }
      if (closeAt !== -1) {
        parts.push(markdown.slice(i, closeAt))
        i = closeAt
        oddBackslash = false
        continue
      }
    }
    const character = markdown[i] ?? ''
    const bare = !oddBackslash
    oddBackslash = character === '\\' ? !oddBackslash : false
    parts.push(character === '$' && bare ? '\\$' : character)
    i += 1
  }
  return parts.join('')
}

function forEachLinkOrImage(
  node: JSONContent,
  visit: (attrs: NonNullable<JSONContent['attrs']>, kind: 'link' | 'image') => void
): void {
  if (node.type === 'image' && node.attrs) {
    visit(node.attrs, 'image')
  }
  node.marks?.forEach((mark) => {
    if (mark.type === 'link' && mark.attrs) {
      visit(mark.attrs, 'link')
    }
  })
  node.content?.forEach((child) => {
    forEachLinkOrImage(child, visit)
  })
}

function attrNeedsRepair(
  attrs: NonNullable<JSONContent['attrs']>,
  kind: 'link' | 'image'
): boolean {
  const dest = kind === 'image' ? attrs.src : attrs.href
  return (
    (typeof dest === 'string' && destNeedsEscape(dest)) ||
    (typeof attrs.title === 'string' && hasBare(attrs.title, '"')) ||
    (kind === 'image' && typeof attrs.alt === 'string' && hasBare(attrs.alt, '[]\\'))
  )
}

function needsAttrRepair(node: JSONContent): boolean {
  let needed = false
  forEachLinkOrImage(node, (attrs, kind) => {
    if (attrNeedsRepair(attrs, kind)) {
      needed = true
    }
  })
  return needed
}

function escapeLinkAndImageAttributes(node: JSONContent): void {
  forEachLinkOrImage(node, (attrs, kind) => {
    const destKey = kind === 'image' ? 'src' : 'href'
    const dest = attrs[destKey]
    if (typeof dest === 'string' && destNeedsEscape(dest)) {
      attrs[destKey] = escapeBare(dest, '()')
    }
    if (typeof attrs.title === 'string' && hasBare(attrs.title, '"')) {
      attrs.title = escapeBare(attrs.title, '"')
    }
    if (kind === 'image' && typeof attrs.alt === 'string' && hasBare(attrs.alt, '[]\\')) {
      attrs.alt = escapeBare(attrs.alt, '[]\\')
    }
  })
}

function pairBlocks(
  json: JSONContent,
  pm: ProseMirrorNode,
  inTableCell: boolean,
  map: Map<JSONContent, BlockInfo>
): void {
  if (json.type === 'paragraph' || json.type === 'heading') {
    map.set(json, { block: pm, inTableCell })
  }
  const children = json.content
  if (!children || children.length !== pm.childCount) {
    return
  }
  const next = inTableCell || json.type === 'tableCell' || json.type === 'tableHeader'
  children.forEach((child, index) => {
    pairBlocks(child, pm.child(index), next, map)
  })
}

function shouldTryDollar(block: ProseMirrorNode): boolean {
  let skip = false
  block.descendants((node) => {
    if (DOLLAR_SKIP_TYPES.has(node.type.name)) {
      skip = true
      return false
    }
    return true
  })
  return !skip
}

export function preserveLiteralMarkdownSource(
  editor: Editor,
  codec: RichMarkdownEditorCodec,
  htmlSuperscriptLinks: boolean
): void {
  const manager = editor.markdown!
  const render = manager.renderNodeToMarkdown.bind(manager)
  const renderNodes = manager.renderNodes.bind(manager)
  const serialize = editor.getMarkdown.bind(editor)
  const cache = new WeakMap<ProseMirrorNode, CacheEntry>()
  let blocks: Map<JSONContent, BlockInfo> | undefined
  let hasRefDefs = false

  const proves = (candidate: string, block: ProseMirrorNode): boolean => {
    try {
      const parsed = manager.parse(
        encodeRawMarkdownHtmlForRichEditor(candidate, codec, { htmlSuperscriptLinks })
      )
      return parsed.content?.length === 1 && editor.schema.nodeFromJSON(parsed.content[0]).eq(block)
    } catch {
      return false
    }
  }

  manager.renderNodes = (nodeOrNodes, parentNode, ...args) => {
    const result = renderNodes(nodeOrNodes, parentNode, ...args)
    if (parentNode?.type !== 'table' || nodeOrNodes === parentNode) {
      return result
    }
    return escapeBare(result, '|')
  }

  manager.renderNodeToMarkdown = (node, ...args) => {
    const info = blocks?.get(node)
    if (!info) {
      return render(node, ...args)
    }
    const markdown = render(node, ...args)
    const cached = cache.get(info.block)
    if (
      cached?.markdown === markdown &&
      cached.inTableCell === info.inTableCell &&
      cached.hasRefDefs === hasRefDefs
    ) {
      return cached.result
    }
    let result = markdown
    if (node.type === 'paragraph' && !info.inTableCell) {
      result = escapeLineLeading(result)
    }
    if (!hasRefDefs) {
      const droppedBrackets = dropOptionalEscapes(result, false)
      if (droppedBrackets !== result && proves(droppedBrackets, info.block)) {
        result = droppedBrackets
      } else if (droppedBrackets !== result) {
        const droppedWithUnderscore = dropOptionalEscapes(result, true)
        if (
          droppedWithUnderscore !== droppedBrackets &&
          proves(droppedWithUnderscore, info.block)
        ) {
          result = droppedWithUnderscore
        }
      }
    }
    if (shouldTryDollar(info.block) && /\$/.test(result) && !proves(result, info.block)) {
      const dollared = escapeBareDollarsSkippingCode(result)
      if (dollared !== result && proves(dollared, info.block)) {
        result = dollared
      }
    }
    cache.set(info.block, {
      markdown,
      inTableCell: info.inTableCell,
      hasRefDefs,
      result
    })
    return result
  }

  editor.getMarkdown = () => {
    const idle = serialize()
    hasRefDefs = REF_DEF.test(withoutOptionalEscapes(idle))
    const json = editor.getJSON()
    if (!hasRefDefs && !CHEAP_NEEDS_WORK.test(idle) && !needsAttrRepair(json)) {
      return idle
    }
    escapeLinkAndImageAttributes(json)
    blocks = new Map()
    pairBlocks(json, editor.state.doc, false, blocks)
    try {
      return manager.serialize(json)
    } finally {
      blocks = undefined
    }
  }
}
