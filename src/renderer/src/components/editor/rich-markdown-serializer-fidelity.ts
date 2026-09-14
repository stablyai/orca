import { Extension, type JSONContent } from '@tiptap/core'
import {
  escapedCharacterSourceText,
  RICH_MARKDOWN_ESCAPED_CHARACTER_MARK
} from './rich-markdown-escaped-character'

type SerializerContext = {
  insideTableCell: boolean
}

/**
 * Wraps `getMarkdown` so the document JSON is rewritten into its source form
 * before Tiptap serializes it. Tiptap 3.22.5 writes text, link destinations and
 * image alt text verbatim, which re-parses differently whenever they hold
 * markdown syntax; each rule below is one such case the parser accepted.
 */
export const RichMarkdownSerializerFidelity = Extension.create({
  name: 'richMarkdownSerializerFidelity',

  onBeforeCreate() {
    // Why: must be registered after `Markdown`, whose onBeforeCreate installs the
    // getMarkdown this replaces; the manager itself is what serializes.
    const editor = this.editor
    editor.getMarkdown = () => {
      const manager = editor.markdown
      if (!manager) {
        throw new Error('RichMarkdownSerializerFidelity requires the Markdown extension')
      }
      return manager.serialize(toSourceForm(editor.getJSON(), { insideTableCell: false }))
    }
  }
})

function toSourceForm(node: JSONContent, context: SerializerContext): JSONContent {
  if (node.type === 'text') {
    return textToSourceForm(node, context)
  }
  const next: JSONContent = node.type === 'image' ? imageToSourceForm(node, context) : node
  if (!next.content) {
    return next
  }
  const childContext =
    node.type === 'tableCell' || node.type === 'tableHeader'
      ? { ...context, insideTableCell: true }
      : context
  return { ...next, content: next.content.map((child) => toSourceForm(child, childContext)) }
}

function textToSourceForm(node: JSONContent, context: SerializerContext): JSONContent {
  const marks = (node.marks ?? []).map((mark) => linkMarkToSourceForm(mark, context))
  const escaped = marks.some((mark) => mark.type === RICH_MARKDOWN_ESCAPED_CHARACTER_MARK)
  const insideCode = marks.some((mark) => mark.type === 'code')
  const text = escaped
    ? escapedCharacterSourceText(node.text ?? '', insideCode)
    : escapeTableCellPipes(node.text ?? '', context)
  const kept = marks.filter((mark) => mark.type !== RICH_MARKDOWN_ESCAPED_CHARACTER_MARK)
  return kept.length > 0 ? { ...node, text, marks: kept } : { type: 'text', text }
}

function linkMarkToSourceForm(
  mark: NonNullable<JSONContent['marks']>[number],
  context: SerializerContext
) {
  if (mark.type !== 'link' || !mark.attrs) {
    return mark
  }
  return {
    ...mark,
    attrs: {
      ...mark.attrs,
      href: destinationToSourceForm(mark.attrs.href, context),
      title: titleToSourceForm(mark.attrs.title, context)
    }
  }
}

function imageToSourceForm(node: JSONContent, context: SerializerContext): JSONContent {
  if (!node.attrs) {
    return node
  }
  return {
    ...node,
    attrs: {
      ...node.attrs,
      src: destinationToSourceForm(node.attrs.src, context),
      alt:
        typeof node.attrs.alt === 'string'
          ? escapeTableCellPipes(node.attrs.alt.replace(/[\\[\]]/g, '\\$&'), context)
          : node.attrs.alt,
      title: titleToSourceForm(node.attrs.title, context)
    }
  }
}

// Why: a bare destination ends at an unbalanced `)`; marked unescapes `\(` and `\)` back on load.
// (The `<…>` form is not an option here: Orca's raw-HTML pass would placeholder it before parsing.)
function destinationToSourceForm(destination: unknown, context: SerializerContext): unknown {
  return typeof destination === 'string'
    ? escapeTableCellPipes(destination.replace(/[()]/g, '\\$&'), context)
    : destination
}

function titleToSourceForm(title: unknown, context: SerializerContext): unknown {
  return typeof title === 'string'
    ? escapeTableCellPipes(title.replace(/"/g, '\\"'), context)
    : title
}

// Why: marked splits cells on unescaped `|` before parsing anything inside them, attributes included.
function escapeTableCellPipes(text: string, context: SerializerContext): string {
  return context.insideTableCell ? text.replace(/\|/g, '\\|') : text
}
