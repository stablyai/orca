import type { Editor } from '@tiptap/core'
import { getRichMarkdownSerializationDocument } from './rich-markdown-trailing-paragraph'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { diffArrays } from 'diff'
import { extractAbsorbedBlankLines } from '@tiptap/markdown'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import type { RichMarkdownEditorCodec } from './rich-markdown-source-transport'
import {
  reconcileSerializedMarkdown,
  restoreMarkdownSourceEol
} from './rich-markdown-source-reconcile'

type SourceBlock = { node: ProseMirrorNode; source: string; separator: string }
type SourceDocument = { source: string; leading: string; blocks: SourceBlock[] }
type SourceContext = {
  codec: RichMarkdownEditorCodec
  htmlSuperscriptLinks: boolean
  baseline?: SourceDocument
}

const contexts = new WeakMap<Editor, SourceContext>()

export function registerRichMarkdownBlockSource(
  editor: Editor,
  codec: RichMarkdownEditorCodec,
  htmlSuperscriptLinks: boolean
): void {
  contexts.set(editor, { codec, htmlSuperscriptLinks })
}

function parse(editor: Editor, context: SourceContext, source: string): ProseMirrorNode {
  return editor.schema.nodeFromJSON(
    editor.markdown!.parse(encodeRawMarkdownHtmlForRichEditor(source, context.codec, context))
  )
}

function readSourceDocument(
  editor: Editor,
  context: SourceContext,
  source: string,
  expected?: ProseMirrorNode
): SourceDocument | null {
  const normalized = source.replace(/\r\n/g, '\n')
  const document = expected ?? parse(editor, context, normalized)
  const tokens = extractAbsorbedBlankLines(context.codec.marked.lexer(normalized))
  // Definitions and custom source owners may cross token boundaries; never guess their spans.
  if (tokens.map((token) => token.raw).join('') !== normalized) {
    return null
  }
  const blocks: SourceBlock[] = []
  let leading = ''
  const lastContentIndex = tokens.findLastIndex((token) => token.type !== 'space')
  for (const [tokenIndex, token] of tokens.entries()) {
    const raw = token.raw
    if (raw === undefined) {
      return null
    }
    if (token.type === 'space') {
      const pieces: string[] = []
      let offset = 0
      for (const match of raw.matchAll(/\n\n/g)) {
        pieces.push(raw.slice(offset, match.index + 2))
        offset = match.index + 2
      }
      const remainder = raw.slice(offset)
      const previous = blocks.at(-1)
      if (pieces.length === 0) {
        if (previous) {
          previous.separator += remainder
        } else {
          leading += remainder
        }
        continue
      }
      const atEnd = tokenIndex > lastContentIndex
      if (previous) {
        previous.separator += pieces.shift()!
      }
      // Match the parser's implicit paragraphs, including leading/trailing blank runs.
      for (const separator of pieces) {
        blocks.push({ node: editor.schema.nodes.paragraph.create(), source: '', separator })
      }
      if (previous && atEnd) {
        blocks.push({
          node: editor.schema.nodes.paragraph.create(),
          source: '',
          separator: remainder
        })
      } else {
        blocks.at(-1)!.separator += remainder
      }
      continue
    }
    const text = raw.replace(/\n+$/, '')
    if (blocks.length >= document.childCount) {
      return null
    }
    // These spans are provisional; the assembled document must pass the full parse proof below.
    blocks.push({
      node: document.child(blocks.length),
      source: text,
      separator: raw.slice(text.length)
    })
  }
  if (
    document.childCount !== blocks.length ||
    blocks.some((block, index) => !block.node.eq(document.child(index)))
  ) {
    return null
  }
  return { source, leading, blocks }
}

/** Reuse exact source for equal blocks, even when character-level reconciliation cannot match. */
export function reconcileRichMarkdownBlockSource(
  editor: Editor,
  originalSource: string,
  edited: string,
  roundTrip: (source: string) => string | null
): string | null {
  const context = contexts.get(editor)
  if (!context) {
    return null
  }
  try {
    const baseline =
      context.baseline?.source === originalSource
        ? context.baseline
        : readSourceDocument(editor, context, originalSource)
    if (!baseline) {
      return null
    }
    context.baseline = baseline
    const document = getRichMarkdownSerializationDocument(editor)
    const current = readSourceDocument(editor, context, edited, document)
    if (!current) {
      return null
    }
    // Bound replacement-heavy diffs; ordinary single-block edits remain linear in document size.
    const changes = diffArrays(baseline.blocks, current.blocks, {
      comparator: (before, after) => before.node.eq(after.node),
      maxEditLength: 256
    })
    if (!changes) {
      return null
    }
    const blocks: SourceBlock[] = []
    let originalIndex = 0
    let removed: SourceBlock[] = []
    for (const change of changes) {
      if (change.added) {
        for (const [index, block] of change.value.entries()) {
          const previous = removed.length === change.count ? removed[index] : undefined
          const canonical = previous ? roundTrip(previous.source) : null
          const source =
            previous && canonical !== null
              ? reconcileSerializedMarkdown({
                  originalSource: previous.source,
                  baseCanonical: canonical,
                  edited: block.source,
                  roundTrip
                })
              : block.source
          blocks.push({ ...block, source, separator: previous?.separator ?? block.separator })
        }
        removed = []
      } else if (change.removed) {
        removed = baseline.blocks.slice(originalIndex, originalIndex + change.count)
        originalIndex += change.count
      } else {
        removed = []
        blocks.push(...baseline.blocks.slice(originalIndex, originalIndex + change.count))
        originalIndex += change.count
      }
    }
    // A moved EOF block needs a separator before the next block.
    for (let index = 0; index < blocks.length - 1; index++) {
      if (!blocks[index].separator) {
        blocks[index] = { ...blocks[index], separator: '\n\n' }
      }
    }
    const assemble = () =>
      baseline.leading + blocks.map((block) => block.source + block.separator).join('')
    let candidate = assemble()
    // Validate the assembled document, including cross-block reference and delimiter interactions.
    if (!parse(editor, context, candidate).eq(document)) {
      const originalIndices = new Map(baseline.blocks.map((block, index) => [block, index]))
      for (let index = 0; index < blocks.length - 1; index++) {
        const originalIndex = originalIndices.get(blocks[index])
        const unchangedBoundary =
          originalIndex !== undefined &&
          originalIndices.get(blocks[index + 1]) === originalIndex + 1
        if (!unchangedBoundary && !blocks[index].separator.includes('\n\n')) {
          blocks[index] = { ...blocks[index], separator: '\n\n' }
        }
      }
      candidate = assemble()
      if (!parse(editor, context, candidate).eq(document)) {
        return null
      }
    }
    const result = restoreMarkdownSourceEol(candidate, originalSource)
    context.baseline = { source: result, leading: baseline.leading, blocks }
    return result
  } catch {
    return null
  }
}
