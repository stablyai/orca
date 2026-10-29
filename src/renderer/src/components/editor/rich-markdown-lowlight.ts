import { getChangedRanges } from '@tiptap/core'
import { CodeBlock } from '@tiptap/extension-code-block'
import CodeBlockLowlight, {
  type CodeBlockLowlightOptions
} from '@tiptap/extension-code-block-lowlight'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { createLowlight } from 'lowlight'

type Lowlight = ReturnType<typeof createLowlight>
type HighlightNode = ReturnType<Lowlight['highlight']>['children'][number]
type CodeBlockAt = { node: ProseMirrorNode; pos: number }
type DocumentRange = { from: number; to: number }
type HighlightSpan = { text: string; classes: string[] }

function parseHighlightNodes(nodes: HighlightNode[], classes: string[] = []): HighlightSpan[] {
  return nodes.flatMap((node) => {
    if (node.type === 'text') {
      return [{ text: node.value, classes }]
    }
    if (node.type !== 'element') {
      return []
    }

    const className = node.properties.className
    const ownClasses = Array.isArray(className)
      ? className.map(String)
      : typeof className === 'string'
        ? [className]
        : []
    return parseHighlightNodes(node.children, [...classes, ...ownClasses])
  })
}

function highlightBlock(
  block: CodeBlockAt,
  lowlight: Lowlight,
  languages: ReadonlySet<string>,
  defaultLanguage: string | null | undefined
): Decoration[] {
  const language = (block.node.attrs.language as string | null | undefined) || defaultLanguage
  const highlighted =
    language && (languages.has(language) || lowlight.registered(language))
      ? lowlight.highlight(language, block.node.textContent)
      : lowlight.highlightAuto(block.node.textContent)
  const decorations: Decoration[] = []
  let from = block.pos + 1

  for (const span of parseHighlightNodes(highlighted.children)) {
    const to = from + span.text.length
    if (span.classes.length > 0) {
      decorations.push(Decoration.inline(from, to, { class: span.classes.join(' ') }))
    }
    from = to
  }

  return decorations
}

function findAllCodeBlocks(doc: ProseMirrorNode, name: string): CodeBlockAt[] {
  const blocks: CodeBlockAt[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === name) {
      blocks.push({ node, pos })
      return false
    }
    return true
  })
  return blocks
}

function findCodeBlocksNearRanges(
  doc: ProseMirrorNode,
  name: string,
  ranges: DocumentRange[]
): CodeBlockAt[] {
  const blocks = new Map<number, ProseMirrorNode>()
  const addResolvedBlocks = (position: number): void => {
    // Why: zero-width inserts and deletes have no nodesBetween span.
    const $position = doc.resolve(Math.max(0, Math.min(doc.content.size, position)))
    for (let depth = $position.depth; depth > 0; depth -= 1) {
      const node = $position.node(depth)
      if (node.type.name === name) {
        blocks.set($position.before(depth), node)
        break
      }
    }
    if ($position.nodeBefore?.type.name === name) {
      blocks.set($position.pos - $position.nodeBefore.nodeSize, $position.nodeBefore)
    }
    if ($position.nodeAfter?.type.name === name) {
      blocks.set($position.pos, $position.nodeAfter)
    }
  }

  for (const range of ranges) {
    const from = Math.max(0, Math.min(doc.content.size, range.from))
    const to = Math.max(from, Math.min(doc.content.size, range.to))
    if (from < to) {
      doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name === name) {
          blocks.set(pos, node)
          return false
        }
        return true
      })
    }
    addResolvedBlocks(from)
    if (to !== from) {
      addResolvedBlocks(to)
    }
  }
  return [...blocks].map(([pos, node]) => ({ node, pos }))
}

function createDecorations(
  doc: ProseMirrorNode,
  name: string,
  lowlight: Lowlight,
  languages: ReadonlySet<string>,
  defaultLanguage: string | null | undefined
): DecorationSet {
  return DecorationSet.create(
    doc,
    findAllCodeBlocks(doc, name).flatMap((block) =>
      highlightBlock(block, lowlight, languages, defaultLanguage)
    )
  )
}

function updateDecorations(
  transaction: Transaction,
  decorationSet: DecorationSet,
  name: string,
  lowlight: Lowlight,
  languages: ReadonlySet<string>,
  defaultLanguage: string | null | undefined
): DecorationSet {
  if (!transaction.docChanged) {
    return decorationSet
  }

  const changes = getChangedRanges(transaction)
  if (changes.length === 0) {
    // Why: attribute-only steps can change a code language without exposing a mapped range.
    return createDecorations(transaction.doc, name, lowlight, languages, defaultLanguage)
  }

  // Why: mapped decorations stay valid outside code blocks touched by the transaction.
  let next = decorationSet.map(transaction.mapping, transaction.doc)
  const oldBlocks = findCodeBlocksNearRanges(
    transaction.before,
    name,
    changes.map((change) => change.oldRange)
  )
  const staleDecorations = new Set<Decoration>()
  for (const block of oldBlocks) {
    const from = transaction.mapping.map(block.pos, -1)
    const to = transaction.mapping.map(block.pos + block.node.nodeSize, 1)
    for (const decoration of next.find(Math.min(from, to), Math.max(from, to))) {
      staleDecorations.add(decoration)
    }
  }
  if (staleDecorations.size > 0) {
    next = next.remove([...staleDecorations])
  }

  const newBlocks = findCodeBlocksNearRanges(
    transaction.doc,
    name,
    changes.map((change) => change.newRange)
  )
  return next.add(
    transaction.doc,
    newBlocks.flatMap((block) => highlightBlock(block, lowlight, languages, defaultLanguage))
  )
}

function createRichMarkdownLowlightPlugin({
  name,
  lowlight,
  defaultLanguage
}: {
  name: string
  lowlight: Lowlight
  defaultLanguage: string | null | undefined
}): Plugin<DecorationSet> {
  const languages = new Set(lowlight.listLanguages())
  const key = new PluginKey<DecorationSet>('richMarkdownLowlight')
  const plugin = new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, { doc }) => createDecorations(doc, name, lowlight, languages, defaultLanguage),
      apply: (transaction, decorationSet) =>
        updateDecorations(transaction, decorationSet, name, lowlight, languages, defaultLanguage)
    },
    props: {
      decorations: (state) => key.getState(state)
    }
  })
  return plugin
}

export const RichMarkdownCodeBlockLowlight = CodeBlock.extend<CodeBlockLowlightOptions>({
  addOptions() {
    return { ...CodeBlockLowlight.options }
  },
  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      createRichMarkdownLowlightPlugin({
        name: this.name,
        lowlight: this.options.lowlight as Lowlight,
        defaultLanguage: this.options.defaultLanguage
      })
    ]
  }
})
