import { renderTableToMarkdown, Table } from '@tiptap/extension-table'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import type { RichMarkdownEditorCodec } from './rich-markdown-source-transport'

export function createRichMarkdownTable(codec: RichMarkdownEditorCodec) {
  return Table.extend({
    renderMarkdown(node, helpers) {
      return renderTableToMarkdown(node, {
        ...helpers,
        // Escape cell content before the upstream renderer inserts column delimiters.
        renderChildren: (...args) => escapeTablePipes(helpers.renderChildren(...args), codec)
      })
    }
  })
}

function escapeTablePipes(content: string, codec: RichMarkdownEditorCodec): string {
  if (!content.includes('|')) {
    return content
  }
  // The source encoder shields HTML and document links before table splitting.
  const encoded = encodeRawMarkdownHtmlForRichEditor(content, codec).replace(
    /(\\*)\|/g,
    (match, backslashes: string) => (backslashes.length % 2 === 0 ? `${backslashes}\\|` : match)
  )
  const { transport } = codec
  return encoded
    .split(transport.authoredPrefix)
    .map((part, index) => {
      if (index === 0) {
        return part
      }
      const source = transport.authoredPrefix + part
      for (const kind of ['literal', 'inline-html', 'block-html', 'document-link'] as const) {
        const token = transport.match(source, kind)
        if (token) {
          const value = kind === 'document-link' ? `[[${token.value}]]` : token.value
          return value + source.slice(token.raw.length)
        }
      }
      return source
    })
    .join('')
}
