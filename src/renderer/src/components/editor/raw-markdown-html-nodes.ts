import { Node, mergeAttributes } from '@tiptap/core'
import type {
  RichMarkdownSourceKind,
  RichMarkdownSourceTransport
} from './rich-markdown-source-transport'

export function createRichMarkdownLiteral(transport: RichMarkdownSourceTransport) {
  return createRawSourceNode({
    name: 'richMarkdownLiteral',
    kind: 'literal',
    inline: true,
    transport,
    marker: 'data-rich-markdown-literal'
  })
}

export function createRawMarkdownHtmlInline(transport: RichMarkdownSourceTransport) {
  return createRawSourceNode({
    name: 'rawMarkdownHtmlInline',
    kind: 'inline-html',
    inline: true,
    transport,
    marker: 'data-raw-markdown-html-inline',
    className: 'raw-markdown-html-inline'
  })
}

export function createRawMarkdownHtmlBlock(transport: RichMarkdownSourceTransport) {
  return createRawSourceNode({
    name: 'rawMarkdownHtmlBlock',
    kind: 'block-html',
    inline: false,
    transport,
    marker: 'data-raw-markdown-html-block',
    className: 'raw-markdown-html-block'
  })
}

function createRawSourceNode({
  name,
  kind,
  inline,
  transport,
  marker,
  className
}: {
  name: string
  kind: RichMarkdownSourceKind
  inline: boolean
  transport: RichMarkdownSourceTransport
  marker: string
  className?: string
}) {
  return Node.create({
    name,
    inline,
    group: inline ? 'inline' : 'block',
    atom: true,
    selectable: true,

    addAttributes() {
      return {
        value: {
          default: '',
          rendered: false
        }
      }
    },

    // Why: converting embedded HTML tags into placeholder tokens before the
    // markdown parser runs keeps marked's built-in paragraph tokenization intact
    // while still letting Orca round-trip the raw markup verbatim.
    markdownTokenName: name,
    markdownTokenizer: {
      name,
      level: inline ? 'inline' : 'block',
      start: transport.startFor(kind),
      tokenize(src) {
        const matched = transport.match(src, kind)
        if (!matched) {
          return undefined
        }

        return {
          type: name,
          raw: matched.raw,
          text: matched.value,
          block: !inline
        }
      }
    },
    parseMarkdown: (token, helpers) => {
      if (token.type !== name) {
        return []
      }

      return helpers.createNode(name, {
        value: typeof token.text === 'string' ? token.text : ''
      })
    },
    renderMarkdown: (node) => (typeof node.attrs?.value === 'string' ? node.attrs.value : ''),
    renderText: ({ node }) => (typeof node.attrs.value === 'string' ? node.attrs.value : ''),

    parseHTML() {
      return [
        {
          tag: `${inline ? 'span' : 'div'}[${marker}]`,
          getAttrs: (element: HTMLElement) => ({ value: element.textContent ?? '' })
        }
      ]
    },

    renderHTML({ HTMLAttributes, node }) {
      const value = typeof node.attrs.value === 'string' ? node.attrs.value : ''
      return [
        inline ? 'span' : 'div',
        mergeAttributes(HTMLAttributes, {
          [marker]: '',
          contenteditable: 'false',
          class: className
        }),
        inline ? value : ['pre', value]
      ]
    }
  })
}
